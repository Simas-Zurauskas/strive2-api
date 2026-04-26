import crypto from 'node:crypto';
import { RunnableConfig } from '@langchain/core/runnables';
import { BFL_API_KEY } from '@conf/env';
import { uploadBuffer, getPresignedUrl, objectExists } from '@services/s3Service';
import { recordUsage } from '@services/usageService';
import { bgError } from '@lib/bg';
import { bumpLinksGenerationOutcome } from '@lib/metrics';
import { priceFlatUnit } from '@lib/pricing';
import { ILessonBlock } from '@models/LessonContentModel';
import type { LessonProgressWriter } from '@src/types/socketEvents';
import { LessonState } from '../state';
import { curateLinks, toEmptyStateBlock } from '../links';

// ── BFL image model ──────────────────────────────────

const BFL_API_BASE = 'https://api.bfl.ai/v1';
const BFL_MODEL_PATH = '/flux-dev';
const BFL_MODEL_SKU = 'bfl_flux_dev' as const;
const BFL_POLL_INTERVAL_MS = 3_000;
const BFL_TIMEOUT_MS = 120_000;

/**
 * Guard against SSRF via BFL response injection.
 *
 * The pollingUrl and image sample URL we later `fetch()` both come out of
 * BFL response bodies. If BFL's infra were compromised — or an intermediary
 * MITM'd — the response could point us at internal-network hosts (e.g.
 * `http://localhost:6379`, the EC2 metadata endpoint, a staging DB). Since
 * we send the BFL API key on the poll call, an attacker could also trick
 * us into leaking it to their own server. We only follow https URLs whose
 * hostname is under `bfl.ai`.
 */
const isBflUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'bfl.ai' || host.endsWith('.bfl.ai');
  } catch {
    return false;
  }
};

const pollBflResult = async (pollingUrl: string): Promise<string> => {
  if (!isBflUrl(pollingUrl)) {
    throw new Error('BFL returned a polling URL outside the bfl.ai origin');
  }

  const startedAt = Date.now();

  while (Date.now() - startedAt < BFL_TIMEOUT_MS) {
    const res = await fetch(pollingUrl, {
      headers: { accept: 'application/json', 'X-Key': BFL_API_KEY },
    });
    if (!res.ok) throw new Error(`BFL poll failed: ${res.status} ${res.statusText}`);

    const data = (await res.json()) as {
      status: string;
      result?: { sample: string };
    };

    if (data.status === 'Ready') {
      if (!data.result?.sample) throw new Error('BFL returned Ready but no sample URL');
      return data.result.sample;
    }

    if (data.status === 'Error' || data.status === 'Failed') {
      throw new Error(`BFL image generation failed (status: ${data.status})`);
    }

    await new Promise((r) => setTimeout(r, BFL_POLL_INTERVAL_MS));
  }

  throw new Error(`BFL image generation timed out after ${BFL_TIMEOUT_MS / 1000}s`);
};

// ── Hero image ─────────────────────────────────────────

const IMAGE_STYLES = [
  'Mixed-media collage aesthetic with torn paper layers, ink stamp textures, and hand-drawn annotation marks. Muted parchment-toned base with one bold accent colour.',
  'Flat vector illustration with bold geometric shapes, clean lines, and a limited palette of 3-4 saturated colours on a soft off-white background. Slight grain overlay for print texture.',
  'Watercolour wash painting with soft, bleeding edges and layered translucent pigments. Earthy natural tones with one vivid highlight colour pooling at focal points.',
  'Isometric 3D-style low-poly render with pastel surfaces, soft ambient shadows, and a miniature diorama feel. Clean, toy-like aesthetic.',
  'Vintage science-textbook engraving style with fine crosshatch lines, sepia and deep navy tones, and a single copper-orange accent. Aged paper texture.',
  'Risograph print aesthetic with misregistered halftone dots, 2-3 spot colours layered with visible overlap, and a lo-fi zine feel on recycled paper.',
  'Japanese woodblock-inspired illustration with flat colour planes, bold outlines, subtle wood-grain texture, and a harmonious warm-cool colour split.',
  'Blueprint / technical-drawing style with white linework on deep indigo background, precise geometric constructions, and occasional chalk-like annotations.',
] as const;

const getStyleForLesson = ({ moduleIndex, lessonIndex }: { moduleIndex: number; lessonIndex: number }): string => {
  const index = (moduleIndex * 7 + lessonIndex) % IMAGE_STYLES.length;
  return IMAGE_STYLES[index];
};

// Bump this when the hero-image prompt template changes in a way that should
// invalidate previously-cached hashes. All content-hash-derived S3 keys
// include this number so a template change forces fresh generations without
// hunting down stale keys.
const HERO_PROMPT_TEMPLATE_VERSION = 2;

/**
 * Deterministic hash of the inputs that drive the hero-image prompt. Two
 * calls with identical (version, model, lessonName, moduleName, courseGoal,
 * style) map to the same S3 key — so regenerating with unchanged inputs
 * short-circuits to the existing image instead of spending on a fresh BFL
 * call. Dedups across courses too.
 *
 * Always per-lesson — the earlier module-level variant (PR 3.2) merged all
 * lessons within a module onto one shared image and that visibly broke the
 * "each lesson has its own hero" expectation in testing. Reverted to
 * lessonName-inclusive hashing so sibling lessons land on distinct images;
 * identical-input regenerations still hit the cache.
 *
 * Includes the model path in the hash so switching the image model doesn't
 * serve a cached image from the wrong one.
 *
 * Normalizing lowercases and trims only — we do NOT strip punctuation
 * because "R vs Python" and "R, Python" carry different prompt nuance.
 */
const computeHeroHash = ({
  lessonName,
  moduleName,
  courseGoal,
  style,
  modelPath,
}: {
  lessonName: string;
  moduleName: string;
  courseGoal: string;
  style: string;
  modelPath: string;
}): string => {
  const payload = JSON.stringify({
    v: HERO_PROMPT_TEMPLATE_VERSION,
    model: modelPath,
    l: lessonName.trim().toLowerCase(),
    m: moduleName.trim().toLowerCase(),
    g: courseGoal.trim().toLowerCase(),
    s: style,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
};

const generateHeroImage = async ({
  lessonName,
  moduleName,
  courseGoal,
  moduleIndex,
  lessonIndex,
  depth,
}: {
  lessonName: string;
  moduleName: string;
  courseGoal: string;
  moduleIndex: number;
  lessonIndex: number;
  depth: string;
}): Promise<string | null> => {
  try {
    const style = getStyleForLesson({ moduleIndex, lessonIndex });

    // Content-addressed dedup. Shared across courses: two users asking the
    // same lesson name in the same module / goal pay once. Per-lesson
    // regenerations with unchanged inputs also hit this path, which is the
    // common "user tweaked an unrelated field and the job refired" case.
    // Any input change → new hash → fresh BFL call; no risk of serving a
    // stale image for changed inputs.
    const hash = computeHeroHash({
      lessonName,
      moduleName,
      courseGoal,
      style,
      modelPath: BFL_MODEL_PATH,
    });
    const hashKey = `lessons/hero/${hash}.png`;

    if (await objectExists({ key: hashKey })) {
      console.log(`[assetsGeneration] ✓ Hero image cache hit (${hash.slice(0, 8)}…) — skipping BFL`.green);
      recordUsage({
        service: 'bfl',
        action: 'image:hero:dedup_hit',
        costMicroCents: 0,
        metadata: { hash, s3Key: hashKey },
      });
      return hashKey;
    }

    console.log(`[assetsGeneration] Generating hero image (hash ${hash.slice(0, 8)}…)…`.cyan);

    const prompt = `A wide editorial illustration about "${lessonName}" (part of "${moduleName}" in a course on ${courseGoal}). The image must clearly depict the specific subject matter of this lesson — show recognisable objects, diagrams, or scenes that someone familiar with the topic would instantly connect to "${lessonName}". Style: ${style} Wide 16:9 composition. No text, no letters, no digits, no human faces.`;

    // 1. Submit generation task
    const submitRes = await fetch(`${BFL_API_BASE}${BFL_MODEL_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Key': BFL_API_KEY,
      },
      body: JSON.stringify({
        prompt,
        aspect_ratio: '16:9',
        prompt_upsampling: true,
        output_format: 'png',
      }),
    });

    if (!submitRes.ok) {
      const errBody = await submitRes.text();
      throw new Error(`BFL submit failed: ${submitRes.status} — ${errBody}`);
    }

    const { polling_url } = (await submitRes.json()) as { id: string; polling_url: string };

    // 2. Poll until ready
    const imageUrl = await pollBflResult(polling_url);

    // 3. Download image and upload to S3. Sample URL also comes from BFL's
    //    response body — same SSRF concern as the poll URL, enforce the
    //    same origin allowlist before we make an outbound request.
    if (!isBflUrl(imageUrl)) {
      throw new Error('BFL returned an image URL outside the bfl.ai origin');
    }

    // Typical BFL images are 2-4 MB. 10 MB is a generous ceiling that
    // accommodates the occasional high-detail render while preventing a
    // pathological or attacker-supplied response from ballooning heap use
    // to hundreds of MB (the whole payload is `Buffer.from(arrayBuffer)`'d
    // into memory before the S3 upload). We check the Content-Length
    // header pre-download to short-circuit the transfer when possible, and
    // re-check after download for servers that omit or lie about the
    // header.
    const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) throw new Error(`Failed to download BFL image: ${imageRes.status}`);

    const advertised = Number(imageRes.headers.get('content-length') ?? 0);
    if (Number.isFinite(advertised) && advertised > MAX_IMAGE_BYTES) {
      throw new Error(`BFL image exceeds ${MAX_IMAGE_BYTES} byte cap (advertised ${advertised})`);
    }

    const buffer = Buffer.from(await imageRes.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`BFL image exceeds ${MAX_IMAGE_BYTES} byte cap (downloaded ${buffer.byteLength})`);
    }

    // Write to the hash path so subsequent identical-input generations hit
    // the objectExists() short-circuit above. The per-course/module/lesson
    // path is gone — LessonContentModel stores whatever key we return, and
    // reads go through getPresignedUrl/resolveImageUrl which work on any
    // key. Old lessons with legacy `lessons/{courseId}/...` keys continue
    // to read fine (the old objects are still there and lifecycle unchanged).
    await uploadBuffer({ key: hashKey, body: buffer, contentType: 'image/png' });

    console.log(`[assetsGeneration] ✓ Hero image uploaded to S3: ${hashKey}`.green);

    recordUsage({
      service: 'bfl',
      action: 'image:hero',
      costMicroCents: priceFlatUnit({ sku: BFL_MODEL_SKU }),
      metadata: { style, bytes: buffer.byteLength, s3Key: hashKey, hash, model: BFL_MODEL_PATH, depth },
    });

    return hashKey;
  } catch (e) {
    console.warn(`[assetsGeneration] ✗ Hero image failed: ${e instanceof Error ? e.message : e}`.yellow);
    return null;
  }
};

// ── Node: hero image (runs early, parallel with content) ──

export const imageGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  if (!state.includeImage) {
    console.log(`[imageGeneration] Skipped (user opted out)`.gray);
    return { heroImageUrl: null };
  }

  const writer = config?.configurable?.writer as LessonProgressWriter | undefined;

  const s3Key = await generateHeroImage({
    lessonName: state.lessonName,
    moduleName: state.moduleName,
    courseGoal: state.goal,
    moduleIndex: state.moduleIndex,
    lessonIndex: state.lessonIndex,
    depth: state.depth,
  });

  if (s3Key) {
    const presignedUrl = await getPresignedUrl({ key: s3Key });
    writer?.({ type: 'hero_image', url: presignedUrl, s3Key });
  }

  return { heroImageUrl: s3Key };
};

// ── Node: curated links (runs at the end) ─────────────
// Delegates to the 6-stage pipeline in ../links: query-plan → parallel
// search → dedupe → parallel fetch → LLM judge → diversity select.

// Backstop for the whole links pipeline. Individual stages each have their
// own catch and bounded timeouts (LLM clientOptions 60s, Jina 10s/URL,
// Tavily 15s/query via withTavilyTimeout), so happy-path runs land well
// under this cap. This hard timeout exists so a novel failure mode — an
// unbounded hang we didn't predict — can never burn the lesson's 5-min
// stream budget; the lesson ships with an empty-state links block instead.
const LINKS_NODE_TIMEOUT_MS = 90_000;

export const linksGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  if (!state.includeLinks) {
    console.log(`[linksGeneration] Skipped (user opted out)`.gray);
    return { linksBlock: null };
  }

  const writer = config?.configurable?.writer as LessonProgressWriter | undefined;

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<ILessonBlock>((resolve) => {
    timer = setTimeout(() => {
      bgError('linksGeneration.nodeTimeout')(
        new Error(`Links generation exceeded ${LINKS_NODE_TIMEOUT_MS}ms — shipping empty-state block`),
      );
      bumpLinksGenerationOutcome('error');
      resolve(toEmptyStateBlock());
    }, LINKS_NODE_TIMEOUT_MS);
  });

  const linksBlock = await Promise.race([curateLinks(state), timeoutPromise]);
  if (timer) clearTimeout(timer);

  writer?.({ type: 'block', block: linksBlock });

  return { linksBlock };
};
