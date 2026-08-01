import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { moderationCreateMock, anthropicCreateMock, recordUsageMock } = vi.hoisted(() => ({
  moderationCreateMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
  recordUsageMock: vi.fn(),
}));

vi.mock('@lib/openaiEmbeddings', () => ({
  getOpenAIClient: () => ({ moderations: { create: moderationCreateMock } }),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: anthropicCreateMock };
  },
}));

vi.mock('@services/usageService', () => ({ recordUsage: recordUsageMock }));

import {
  moderateText,
  moderateImages,
  moderateTextWithAdjudication,
  adjudicate,
  enumerateEmbeddedImages,
  screenBeforeVision,
  ModerationUnavailableError,
  MODERATION_INCONCLUSIVE_REASON,
  MODERATION_MAX_INPUTS_PER_REQUEST,
  MODERATION_MAX_CHARS_PER_INPUT,
  MODERATION_MAX_IMAGES_PER_REQUEST,
  EMBEDDED_IMAGE_MAX_COUNT,
  ADJUDICATOR_TOOL,
  adjudicationSchema,
} from './documentModeration';
import { buildDocx, buildPptx, buildEpub, buildPdf, buildZip, tinyPng } from './documentExtraction/__fixtures__/builders';
import * as metrics from '@lib/metrics';
import { capsFromZodSchema, collectSchemaCaps, diffAdvertisedCaps } from '@lib/ai/modelOutputCaps';

// ── Response fabricators ────────────────────────────────────

const ALL_CATEGORIES = [
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/instructions',
  'self-harm/intent',
  'sexual',
  'sexual/minors',
  'violence',
  'violence/graphic',
];

const modResult = (scores: Record<string, number> = {}) => ({
  flagged: Object.values(scores).some((s) => s > 0.5),
  categories: Object.fromEntries(ALL_CATEGORIES.map((c) => [c, (scores[c] ?? 0) > 0.5])),
  category_scores: Object.fromEntries(ALL_CATEGORIES.map((c) => [c, scores[c] ?? 0])),
  category_applied_input_types: {},
});

const modResponse = (results: unknown[]) => ({
  id: 'modr_test',
  model: 'omni-moderation-latest',
  results,
});

/** One clean result per input item, whatever the batch size. */
const cleanResponse = () =>
  moderationCreateMock.mockImplementation(async (body: { input: unknown[] | string }) => {
    const count = Array.isArray(body.input) ? body.input.length : 1;
    return modResponse(Array.from({ length: count }, () => modResult()));
  });

const adjudicatorResponse = (verdict: 'allow' | 'reject', reason = 'educational treatment of a sensitive topic') => ({
  content: [{ type: 'tool_use', id: 'tu_1', name: 'adjudicate_content', input: { verdict, reason } }],
  usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

beforeEach(() => {
  moderationCreateMock.mockReset();
  anthropicCreateMock.mockReset();
  recordUsageMock.mockReset();
  cleanResponse();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── moderateText ────────────────────────────────────────────

describe('moderateText', () => {
  it('passes clean text', async () => {
    const verdict = await moderateText(['A friendly chapter about photosynthesis.'], {});
    expect(verdict.decision).toBe('pass');
    expect(verdict.categories).toEqual([]);
  });

  it('rejects hard-band content with category names and never echoes the input', async () => {
    const CANARY = 'CANARY_XK9Q_STRIVE_FIXTURE';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    moderationCreateMock.mockResolvedValue(modResponse([modResult({ violence: 0.99, 'violence/graphic': 0.97 })]));
    const verdict = await moderateText([`${CANARY} extremely violent manifesto text`], { documentId: 'doc1' });

    expect(verdict.decision).toBe('reject');
    expect(verdict.categories).toContain('violence');
    expect(verdict.maxScores['violence']).toBeCloseTo(0.99);

    // The verdict must carry category names only — NEVER content.
    expect(JSON.stringify(verdict)).not.toContain(CANARY);
    // Nothing logged may echo the content either.
    const allLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map(String)
      .join('\n');
    expect(allLogged).not.toContain(CANARY);
  });

  it('rejects always-illegal categories at the lower threshold (no adjudication band)', async () => {
    // 0.45 is far below the general 0.95 hard band but above the
    // always-illegal reject threshold.
    moderationCreateMock.mockResolvedValue(modResponse([modResult({ 'sexual/minors': 0.45 })]));
    const verdict = await moderateText(['x'], {});
    expect(verdict.decision).toBe('reject');
    expect(verdict.categories).toEqual(['sexual/minors']);
  });

  it('routes mid-band scores to adjudicate', async () => {
    moderationCreateMock.mockResolvedValue(modResponse([modResult({ violence: 0.7 })]));
    const verdict = await moderateText(['medieval siege warfare tactics'], {});
    expect(verdict.decision).toBe('adjudicate');
    expect(verdict.categories).toEqual(['violence']);
  });

  it('batches inputs per API limits and splits oversize chunks', async () => {
    const chunks = Array.from({ length: MODERATION_MAX_INPUTS_PER_REQUEST + 8 }, (_, i) => `chunk ${i}`);
    await moderateText(chunks, {});
    expect(moderationCreateMock).toHaveBeenCalledTimes(2);

    moderationCreateMock.mockClear();
    cleanResponse();
    const oversize = 'y'.repeat(MODERATION_MAX_CHARS_PER_INPUT * 2 + 10);
    await moderateText([oversize], {});
    const sent = moderationCreateMock.mock.calls.flatMap((c) => c[0].input as unknown[]);
    expect(sent.length).toBe(3);
  });

  it('fails CLOSED when the moderation API is down (throws, never passes)', async () => {
    moderationCreateMock.mockRejectedValue(new Error('503 service unavailable'));
    await expect(moderateText(['anything'], {})).rejects.toBeInstanceOf(ModerationUnavailableError);
  });

  it('passes trivially on empty/whitespace-only input without calling the API', async () => {
    const verdict = await moderateText(['', '   '], {});
    expect(verdict.decision).toBe('pass');
    expect(moderationCreateMock).not.toHaveBeenCalled();
  });
});

// ── adjudication ────────────────────────────────────────────

describe('moderateTextWithAdjudication', () => {
  it('mid-band + adjudicator allow → pass (educational false-positive path)', async () => {
    // A history text about WWII scoring mid-band on violence must survive.
    moderationCreateMock.mockResolvedValue(modResponse([modResult({ violence: 0.72 })]));
    anthropicCreateMock.mockResolvedValue(adjudicatorResponse('allow'));

    const outcome = await moderateTextWithAdjudication(
      ['The battle of Stalingrad saw brutal urban combat and enormous casualties on both sides.'],
      { documentId: 'doc-hist' },
    );
    expect(outcome.decision).toBe('pass');
    expect(outcome.adjudication?.verdict).toBe('allow');

    // The adjudicator call is a forced-tool Haiku call with the sample
    // framed as untrusted data.
    const call = anthropicCreateMock.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'adjudicate_content' });
    expect(call.temperature).toBe(0);
    const human = JSON.stringify(call.messages);
    expect(human).toContain('external_content');
    expect(human).toContain('untrusted');
  });

  it('mid-band + adjudicator reject → reject', async () => {
    moderationCreateMock.mockResolvedValue(modResponse([modResult({ 'illicit/violent': 0.75 })]));
    anthropicCreateMock.mockResolvedValue(adjudicatorResponse('reject', 'instructional harm content'));

    const outcome = await moderateTextWithAdjudication(['bad chunk'], {});
    expect(outcome.decision).toBe('reject');
    expect(outcome.adjudication?.verdict).toBe('reject');
  });

  it('hard reject short-circuits without calling the adjudicator', async () => {
    moderationCreateMock.mockResolvedValue(modResponse([modResult({ violence: 0.99 })]));
    const outcome = await moderateTextWithAdjudication(['x'], {});
    expect(outcome.decision).toBe('reject');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('pipes the paid adjudicator call into the cost pipeline', async () => {
    moderationCreateMock.mockResolvedValue(modResponse([modResult({ violence: 0.7 })]));
    anthropicCreateMock.mockResolvedValue(adjudicatorResponse('allow'));
    await moderateTextWithAdjudication(['x'], {});
    expect(recordUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'anthropic', action: 'doc:adjudicate' }),
    );
  });
});

describe('adjudicate failure fallback', () => {
  it('LLM failure after retries → reject with moderation_inconclusive (fail closed)', async () => {
    anthropicCreateMock.mockRejectedValue(new Error('529 overloaded'));
    const result = await adjudicate('sample', ['violence'], {});
    expect(result.verdict).toBe('reject');
    expect(result.reason).toBe(MODERATION_INCONCLUSIVE_REASON);
  });

  it('parse miss (no tool_use) → reject with moderation_inconclusive', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'I cannot decide.' }],
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const result = await adjudicate('sample', ['violence'], {});
    expect(result.verdict).toBe('reject');
    expect(result.reason).toBe(MODERATION_INCONCLUSIVE_REASON);
  });

  it('schema-invalid tool payload → reject with moderation_inconclusive', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't', name: 'adjudicate_content', input: { verdict: 'maybe' } }],
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const result = await adjudicate('sample', ['violence'], {});
    expect(result.verdict).toBe('reject');
    expect(result.reason).toBe(MODERATION_INCONCLUSIVE_REASON);
  });

  // An over-long reason is a cosmetic overrun: treating it as a parse miss
  // converted a legitimate ALLOW into a fail-closed inconclusive rejection,
  // which fails the (paid) prepare_corpus job over a formatting slip.
  it('over-long reason is clamped, and an ALLOW verdict survives', async () => {
    const before = metrics.modelOutputClampedTotal['doc:adjudicate'] ?? 0;
    anthropicCreateMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 't',
          name: 'adjudicate_content',
          input: { verdict: 'allow', reason: 'r'.repeat(400) },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const result = await adjudicate('sample', ['violence'], {});
    expect(result.verdict).toBe('allow');
    expect(result.reason).toHaveLength(300);
    expect(metrics.modelOutputClampedTotal['doc:adjudicate'] ?? 0).toBeGreaterThan(before);
  });
});

describe('adjudicate_content tool schema ↔ Zod parity', () => {
  it('advertises every constraint the Zod schema enforces', () => {
    expect(
      diffAdvertisedCaps(capsFromZodSchema(adjudicationSchema), collectSchemaCaps(ADJUDICATOR_TOOL.input_schema)),
    ).toEqual([]);
    expect(capsFromZodSchema(adjudicationSchema).get('reason')?.maxLength).toBe(300);
  });
});

// ── moderateImages ──────────────────────────────────────────

describe('moderateImages', () => {
  it('sends images as base64 data URLs, batched per request cap', async () => {
    const images = Array.from({ length: MODERATION_MAX_IMAGES_PER_REQUEST + 2 }, () => ({
      buffer: tinyPng(),
      mimeType: 'image/png',
    }));
    const verdict = await moderateImages(images, {});
    expect(verdict.decision).toBe('pass');
    expect(moderationCreateMock).toHaveBeenCalledTimes(2);
    const firstInput = moderationCreateMock.mock.calls[0][0].input as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(firstInput[0].type).toBe('image_url');
    expect(firstInput[0].image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it('skips images over the 20 MB API limit with a warning (never sent)', async () => {
    const oversize = { buffer: Buffer.alloc(21 * 1024 * 1024), mimeType: 'image/png' };
    const small = { buffer: tinyPng(), mimeType: 'image/png' };
    const verdict = await moderateImages([oversize, small], {});
    const sent = moderationCreateMock.mock.calls.flatMap((c) => c[0].input as unknown[]);
    expect(sent.length).toBe(1);
    expect(verdict.warnings.some((w) => /20\s?MB/i.test(w))).toBe(true);
  });

  it('rejects a flagged image', async () => {
    moderationCreateMock.mockResolvedValue(modResponse([modResult({ sexual: 0.97 })]));
    const verdict = await moderateImages([{ buffer: tinyPng(), mimeType: 'image/png' }], {});
    expect(verdict.decision).toBe('reject');
    expect(verdict.categories).toContain('sexual');
  });

  it('fails CLOSED on API outage', async () => {
    moderationCreateMock.mockRejectedValue(new Error('down'));
    await expect(moderateImages([{ buffer: tinyPng(), mimeType: 'image/png' }], {})).rejects.toBeInstanceOf(
      ModerationUnavailableError,
    );
  });
});

// ── ordering contract: screenBeforeVision ───────────────────

describe('screenBeforeVision', () => {
  it('moderates BEFORE the vision fn runs, and passes cleared images through', async () => {
    const order: string[] = [];
    moderationCreateMock.mockImplementation(async (body: { input: unknown[] }) => {
      order.push('moderation');
      return modResponse(body.input.map(() => modResult()));
    });
    const vision = vi.fn(async (imgs: Array<{ buffer: Buffer; mimeType: string }>) => {
      order.push('vision');
      return `saw ${imgs.length}`;
    });

    const images = [{ buffer: tinyPng(), mimeType: 'image/png' }];
    const { verdict, visionResult } = await screenBeforeVision(images, {}, vision);

    expect(order).toEqual(['moderation', 'vision']);
    expect(verdict.decision).toBe('pass');
    expect(vision).toHaveBeenCalledWith(images);
    expect(visionResult).toBe('saw 1');
  });

  it('short-circuits on reject — no image bytes ever reach the vision fn', async () => {
    moderationCreateMock.mockResolvedValue(modResponse([modResult({ 'sexual/minors': 0.9 })]));
    const vision = vi.fn(async () => 'should never run');

    const { verdict, visionResult } = await screenBeforeVision(
      [{ buffer: tinyPng(), mimeType: 'image/png' }],
      {},
      vision,
    );
    expect(verdict.decision).toBe('reject');
    expect(vision).not.toHaveBeenCalled();
    expect(visionResult).toBeNull();
  });

  it('excludes unscreenable (oversize) images from the cleared set', async () => {
    const small = { buffer: tinyPng(), mimeType: 'image/png' };
    const oversize = { buffer: Buffer.alloc(21 * 1024 * 1024), mimeType: 'image/png' };
    const vision = vi.fn(async (imgs: unknown[]) => imgs.length);

    const { visionResult } = await screenBeforeVision([small, oversize], {}, vision);
    expect(visionResult).toBe(1);
    expect(vision).toHaveBeenCalledWith([small]);
  });
});

// ── enumerateEmbeddedImages ─────────────────────────────────

describe('enumerateEmbeddedImages', () => {
  it('lists word/media/ images in a docx', () => {
    const { images } = enumerateEmbeddedImages(
      buildDocx({ withImage: true }),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe('image/png');
    expect(images[0].buffer.equals(tinyPng())).toBe(true);
  });

  it('returns no images for a docx without media', () => {
    const { images } = enumerateEmbeddedImages(
      buildDocx(),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(images).toHaveLength(0);
  });

  it('lists ppt/media/ images in a pptx', () => {
    const { images } = enumerateEmbeddedImages(
      buildPptx(['slide one'], { withImage: true }),
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe('image/png');
  });

  it('lists image entries in an epub', () => {
    const { images } = enumerateEmbeddedImages(
      buildEpub([{ title: 'Ch 1', body: 'text' }], { withImage: true }),
      'application/epub+zip',
    );
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe('image/png');
  });

  it('returns nothing for PDFs (documented renderer limitation)', () => {
    const { images, warnings } = enumerateEmbeddedImages(buildPdf(['text page']), 'application/pdf');
    expect(images).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('caps embedded images with a warning beyond the limit', () => {
    const entries = Array.from({ length: EMBEDDED_IMAGE_MAX_COUNT + 5 }, (_, i) => ({
      name: `word/media/image${i}.png`,
      data: tinyPng(),
    }));
    const zip = buildZip(entries);
    const { images, warnings } = enumerateEmbeddedImages(
      zip,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(images).toHaveLength(EMBEDDED_IMAGE_MAX_COUNT);
    expect(warnings.some((w) => w.includes(String(EMBEDDED_IMAGE_MAX_COUNT)))).toBe(true);
  });

  it('skips entries over 20 MB with a warning', () => {
    const zip = buildZip([
      { name: 'word/media/huge.png', data: Buffer.alloc(21 * 1024 * 1024) },
      { name: 'word/media/tiny.png', data: tinyPng() },
    ]);
    const { images, warnings } = enumerateEmbeddedImages(
      zip,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(images).toHaveLength(1);
    expect(warnings.some((w) => /20\s?MB/i.test(w))).toBe(true);
  });

  it('skips non-moderatable image formats (emf/wmf) with a warning', () => {
    const zip = buildZip([
      { name: 'word/media/drawing1.emf', data: Buffer.from('emf-bytes') },
      { name: 'word/media/photo.png', data: tinyPng() },
    ]);
    const { images, warnings } = enumerateEmbeddedImages(
      zip,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(images).toHaveLength(1);
    expect(warnings.some((w) => /unsupported/i.test(w))).toBe(true);
  });
});
