import { z } from 'zod';
import { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { TavilySearch } from '@langchain/tavily';
import { BFL_API_KEY, TAVILY_API_KEY } from '@conf/env';
import { getUtilityModel } from '@lib/langchain';
import { uploadBuffer, getPresignedUrl } from '@services/s3Service';
import { ILessonBlock } from '@models/LessonContentModel';
import { LessonState } from '../state';

const tavilySearch = new TavilySearch({
  maxResults: 8,
  tavilyApiKey: TAVILY_API_KEY,
});

// ── Flux Kontext Pro (BFL API) ────────────────────────

const BFL_API_BASE = 'https://api.bfl.ai/v1';
const BFL_POLL_INTERVAL_MS = 3_000;
const BFL_TIMEOUT_MS = 120_000;

const pollBflResult = async (pollingUrl: string): Promise<string> => {
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

const getStyleForLesson = (moduleIndex: number, lessonIndex: number): string => {
  const index = (moduleIndex * 7 + lessonIndex) % IMAGE_STYLES.length;
  return IMAGE_STYLES[index];
};

const generateHeroImage = async (
  lessonName: string,
  moduleName: string,
  courseGoal: string,
  courseId: string,
  moduleIndex: number,
  lessonIndex: number,
): Promise<string | null> => {
  try {
    console.log(`[assetsGeneration] Generating hero image...`.cyan);

    const style = getStyleForLesson(moduleIndex, lessonIndex);
    const prompt = `A wide editorial illustration about "${lessonName}" (part of "${moduleName}" in a course on ${courseGoal}). The image must clearly depict the specific subject matter of this lesson — show recognisable objects, diagrams, or scenes that someone familiar with the topic would instantly connect to "${lessonName}". Style: ${style} Wide 16:9 composition. No text, no letters, no digits, no human faces.`;

    // 1. Submit generation task
    const submitRes = await fetch(`${BFL_API_BASE}/flux-kontext-pro`, {
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

    // 3. Download image and upload to S3
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) throw new Error(`Failed to download BFL image: ${imageRes.status}`);
    const buffer = Buffer.from(await imageRes.arrayBuffer());

    const key = `lessons/${courseId}/${moduleIndex}/${lessonIndex}/hero.png`;
    await uploadBuffer(key, buffer, 'image/png');

    console.log(`[assetsGeneration] ✓ Hero image uploaded to S3: ${key}`.green);
    return key;
  } catch (e) {
    console.warn(`[assetsGeneration] ✗ Hero image failed: ${e instanceof Error ? e.message : e}`.yellow);
    return null;
  }
};

// ── Curated links ──────────────────────────────────────

// ── Curated links (two-step: search → LLM curation) ───

interface CuratedLink {
  title: string;
  url: string;
  description: string;
}

const curatedLinksSchema = z.object({
  links: z.array(z.object({
    url: z.string(),
    title: z.string(),
    description: z.string(),
  })),
});

const LINKS_CURATION_PROMPT = `You are a learning resource curator. Given a lesson's content and a set of web search results, select ONLY the genuinely valuable resources a learner should read AFTER completing this lesson.

Rules:
- Select 3-5 resources maximum. Quality over quantity — fewer excellent links beat many mediocre ones.
- Each resource must add value BEYOND what the lesson already taught. Ask: "Why would a learner click this?"
- Prefer: official documentation, canonical tutorials, seminal articles/papers, authoritative references, well-maintained open-source repos
- Reject: SEO blog spam, low-effort listicles, paywalled content, outdated material, generic overviews that repeat what the lesson covered
- Write a thoughtful 1-sentence description for each — not a generic summary but WHY this specific resource is worth the learner's time after this lesson
- If none of the search results are genuinely valuable, return an empty links array. Do not pad with mediocre content.`;

const generateCuratedLinks = async (
  lessonName: string,
  lessonSummary: string,
  contentBlocks: ILessonBlock[],
): Promise<ILessonBlock | null> => {
  try {
    // Step 1: Extract key concepts from lesson content for targeted search
    const sectionContent = contentBlocks
      .filter((b) => b.type === 'section')
      .map((b) => b.content.slice(0, 200))
      .join(' ');
    const keyTerms = `${lessonName} ${sectionContent}`.slice(0, 300);

    console.log(`[linksGeneration] Searching with lesson context...`.cyan);
    const results = await tavilySearch.invoke({ query: `${keyTerms} learn guide resource tutorial` });

    // Parse Tavily results
    const raw = results as Record<string, unknown>;
    let items: Array<{ title?: string; url?: string; content?: string }> = [];
    if (raw && Array.isArray(raw.results)) {
      items = raw.results;
    } else if (Array.isArray(results)) {
      items = results;
    }

    const searchResults = items
      .filter((r) => r.url && r.title)
      .slice(0, 10) // Give the LLM more candidates to choose from
      .map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: (r.content ?? '').slice(0, 300),
      }));

    if (searchResults.length === 0) return null;

    // Step 2: LLM curation — Haiku selects and describes the best resources
    console.log(`[linksGeneration] Curating ${searchResults.length} candidates with LLM...`.cyan);

    const model = getUtilityModel().withStructuredOutput(curatedLinksSchema);
    const curationResult = await model.invoke([
      new SystemMessage(LINKS_CURATION_PROMPT),
      new HumanMessage(`## Lesson: ${lessonName}

## Lesson summary
${lessonSummary}

## Search results to evaluate

${searchResults.map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   Snippet: ${r.snippet}`).join('\n\n')}

Select the genuinely valuable resources from the list above.`),
    ]);

    const links: CuratedLink[] = curationResult.links;
    console.log(`[linksGeneration] ✓ Curated ${links.length} links from ${searchResults.length} candidates`.green);

    if (links.length === 0) return null;

    const content = links
      .map((l) => `- [${l.title}](${l.url}) — ${l.description}`)
      .join('\n');

    return {
      id: 'links-1',
      type: 'links',
      content,
      metadata: { links },
      order: 9999,
    };
  } catch (e) {
    console.warn(`[linksGeneration] ✗ Curated links failed: ${e instanceof Error ? e.message : e}`.yellow);
    return null;
  }
};

// ── Node: hero image (runs early, parallel with content) ──

export const imageGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  if (!state.includeImage) {
    console.log(`[imageGeneration] Skipped (user opted out)`.gray);
    return { heroImageUrl: null };
  }

  const writer = (config?.configurable?.writer as ((event: Record<string, unknown>) => void) | undefined);

  const s3Key = await generateHeroImage(
    state.lessonName, state.moduleName, state.goal, state.courseId, state.moduleIndex, state.lessonIndex,
  );

  if (s3Key) {
    const presignedUrl = await getPresignedUrl(s3Key);
    writer?.({ type: 'hero_image', url: presignedUrl, s3Key });
  }

  return { heroImageUrl: s3Key };
};

// ── Node: curated links (runs at the end) ─────────────

export const linksGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  if (!state.includeLinks) {
    console.log(`[linksGeneration] Skipped (user opted out)`.gray);
    return { linksBlock: null };
  }

  const writer = (config?.configurable?.writer as ((event: Record<string, unknown>) => void) | undefined);

  const linksBlock = await generateCuratedLinks(state.lessonName, state.contentSummary, state.contentBlocks);

  if (linksBlock) {
    writer?.({ type: 'block', block: linksBlock });
  }

  return { linksBlock };
};
