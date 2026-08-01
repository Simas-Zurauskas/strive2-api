/**
 * Tests for the map-reduce source digest (Phase 4 of course-from-documents).
 * Pins: forced-tool Haiku plumbing with the doc:digest-map / doc:digest-reduce
 * cost labels, spanRef validation (model-invented refs dropped), the single-doc
 * fast path (no reduce call), untrusted framing of chunk content, and the hard
 * ≤ 8k-token (32k-char serialized) cap.
 *
 * Run: yarn test sourceDigestService
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { anthropicCreateMock, logCacheUsageMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  logCacheUsageMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: anthropicCreateMock };
  },
}));

// importOriginal keeps makeLlmCacheCallback etc. intact — `@lib/langchain`
// (pulled in for MODEL_IDS) calls it at module load.
vi.mock('@lib/ai/cacheLogger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/ai/cacheLogger')>();
  return { ...actual, logCacheUsage: logCacheUsageMock };
});

import {
  buildSourceDigest,
  DigestFailedError,
  DIGEST_MAX_CHARS,
  MAP_TOOL,
  REDUCE_TOOL,
  mapToolSchema,
  reduceToolSchema,
  type DigestDocInput,
} from './sourceDigestService';
import * as metrics from '@lib/metrics';
import { capsFromZodSchema, collectSchemaCaps, diffAdvertisedCaps } from '@lib/ai/modelOutputCaps';

const toolResponse = (name: string, input: unknown) => ({
  content: [{ type: 'tool_use', id: 'tu_1', name, input }],
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

const mapPayload = (topics: Array<{ topic: string; summaryLine: string; spanRefs: number[] }>) => ({ topics });

const docInput = (id: string, chunkCount = 3): DigestDocInput => ({
  documentId: id,
  filename: `${id}.pdf`,
  chunks: Array.from({ length: chunkCount }, (_, i) => ({
    vectorId: `doc:c1:${id}:${i}`,
    text: `Chunk ${i} of ${id}: spaced repetition schedules reviews at growing intervals.`,
    headingPath: ['Chapter'],
  })),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildSourceDigest — map phase', () => {
  test('single document: map only (no reduce call), spanRefs resolved to vectorIds', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      toolResponse('digest_topics', mapPayload([
        { topic: 'Spacing effect', summaryLine: 'Reviews at growing intervals beat massed practice.', spanRefs: [0, 2] },
      ])),
    );

    const digest = await buildSourceDigest([docInput('d1')]);

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1); // no reduce for a single doc
    expect(digest.topics).toHaveLength(1);
    expect(digest.topics[0].topic).toBe('Spacing effect');
    expect(digest.topics[0].spanRefs).toEqual(['doc:c1:d1:0', 'doc:c1:d1:2']);
    expect(digest.topics[0].docIds).toEqual(['d1']);
  });

  test('model-invented spanRefs (out of range) are dropped, never fabricated into vectorIds', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      toolResponse('digest_topics', mapPayload([
        { topic: 'Real topic', summaryLine: 'Fine.', spanRefs: [1, 99] },
      ])),
    );

    const digest = await buildSourceDigest([docInput('d1', 3)]);
    expect(digest.topics[0].spanRefs).toEqual(['doc:c1:d1:1']);
  });

  test('chunk content is sanitized and framed as untrusted external content', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      toolResponse('digest_topics', mapPayload([{ topic: 'T', summaryLine: 'S', spanRefs: [0] }])),
    );

    await buildSourceDigest([docInput('d1', 1)]);

    const call = anthropicCreateMock.mock.calls[0][0];
    const humanText = typeof call.messages[0].content === 'string'
      ? call.messages[0].content
      : JSON.stringify(call.messages[0].content);
    expect(humanText).toContain('<external_content');
    expect(humanText).toContain('untrusted');
  });

  test('cost is piped with the doc:digest-map label', async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      toolResponse('digest_topics', mapPayload([{ topic: 'T', summaryLine: 'S', spanRefs: [0] }])),
    );
    await buildSourceDigest([docInput('d1', 1)]);
    expect(logCacheUsageMock).toHaveBeenCalledWith(expect.objectContaining({ label: 'doc:digest-map' }));
  });

  test('provider failure after retries throws DigestFailedError (no silent fallback)', async () => {
    anthropicCreateMock.mockRejectedValue(new Error('boom'));
    await expect(buildSourceDigest([docInput('d1', 1)])).rejects.toBeInstanceOf(DigestFailedError);
  });

  test('empty input returns an empty tree without any model call', async () => {
    const digest = await buildSourceDigest([]);
    expect(digest.topics).toEqual([]);
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });
});

describe('buildSourceDigest — reduce phase', () => {
  test('multi-document: reduce merges per-doc nodes; nodeRefs resolve to real spanRefs/docIds; invented refs dropped', async () => {
    // Two map calls (one per doc), then one reduce call.
    anthropicCreateMock
      .mockResolvedValueOnce(
        toolResponse('digest_topics', mapPayload([{ topic: 'Alpha', summaryLine: 'A.', spanRefs: [0] }])),
      )
      .mockResolvedValueOnce(
        toolResponse('digest_topics', mapPayload([{ topic: 'Beta', summaryLine: 'B.', spanRefs: [1] }])),
      )
      .mockResolvedValueOnce(
        toolResponse('merge_topics', {
          topics: [
            {
              topic: 'Merged theme',
              nodeRefs: ['n0', 'n1', 'n999'],
              children: [{ topic: 'Alpha detail', nodeRefs: ['n0'] }],
            },
          ],
        }),
      );

    const digest = await buildSourceDigest([docInput('d1'), docInput('d2')]);

    expect(anthropicCreateMock).toHaveBeenCalledTimes(3);
    expect(logCacheUsageMock).toHaveBeenCalledWith(expect.objectContaining({ label: 'doc:digest-reduce' }));

    expect(digest.topics).toHaveLength(1);
    const merged = digest.topics[0];
    expect(merged.spanRefs).toEqual(expect.arrayContaining(['doc:c1:d1:0', 'doc:c1:d2:1']));
    expect(merged.docIds.sort()).toEqual(['d1', 'd2']);
    expect(merged.children).toHaveLength(1);
    expect(merged.children![0].docIds).toEqual(['d1']);
  });

  test('reduce nodes with only invented refs are dropped', async () => {
    anthropicCreateMock
      .mockResolvedValueOnce(toolResponse('digest_topics', mapPayload([{ topic: 'A', summaryLine: 'a', spanRefs: [0] }])))
      .mockResolvedValueOnce(toolResponse('digest_topics', mapPayload([{ topic: 'B', summaryLine: 'b', spanRefs: [0] }])))
      .mockResolvedValueOnce(
        toolResponse('merge_topics', {
          topics: [
            { topic: 'Ghost', nodeRefs: ['n42'] },
            { topic: 'Real', nodeRefs: ['n0'] },
          ],
        }),
      );

    const digest = await buildSourceDigest([docInput('d1'), docInput('d2')]);
    expect(digest.topics.map((t) => t.topic)).toEqual(['Real']);
  });
});

describe('buildSourceDigest — size cap', () => {
  test(`serialized digest never exceeds ${DIGEST_MAX_CHARS} chars (~8k tokens)`, async () => {
    // Two docs; every map window returns max-width topics, and the reduce
    // returns a maximal tree (12 roots × 8 children, all fields at their
    // schema caps) — several times over the serialized budget pre-trim.
    const docs = [docInput('d1', 20), docInput('d2', 20)];
    const mapTopics = Array.from({ length: 10 }, (_, i) => ({
      topic: `Topic ${i} ${'x'.repeat(70)}`.slice(0, 80),
      summaryLine: `Summary ${i} ${'y'.repeat(190)}`.slice(0, 200),
      spanRefs: Array.from({ length: 12 }, (_, j) => (i + j) % 20),
    }));
    const reduceNode = (i: number) => ({
      topic: `Merged ${i} ${'x'.repeat(70)}`.slice(0, 80),
      summaryLine: `Merged summary ${i} ${'y'.repeat(180)}`.slice(0, 200),
      nodeRefs: Array.from({ length: 20 }, (_, j) => `n${j}`),
    });
    const reducePayload = {
      topics: Array.from({ length: 12 }, (_, i) => ({
        ...reduceNode(i),
        children: Array.from({ length: 8 }, (_, j) => reduceNode(i * 8 + j + 100)),
      })),
    };

    anthropicCreateMock.mockImplementation(async (params: { tools: Array<{ name: string }> }) =>
      params.tools[0].name === 'digest_topics'
        ? toolResponse('digest_topics', mapPayload(mapTopics))
        : toolResponse('merge_topics', reducePayload),
    );

    const digest = await buildSourceDigest(docs);

    // Sanity: the untrimmed reduce output would have blown the cap.
    expect(JSON.stringify(reducePayload).length).toBeGreaterThan(DIGEST_MAX_CHARS);
    expect(JSON.stringify(digest).length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest.topics.length).toBeGreaterThan(0);
  });
});

// ── Tool-schema ↔ Zod parity + cosmetic-overrun clamping ────
//
// Same bug class as `doc:assess` (BUG 1): a cap Zod enforced and the tool
// schema never advertised, re-sent identically by withRetry, ending in a
// DigestFailedError that kills the (paid) prepare_corpus job.

describe('digest tool schemas ↔ Zod parity', () => {
  test('digest_topics advertises every constraint the map Zod schema enforces', () => {
    expect(
      diffAdvertisedCaps(capsFromZodSchema(mapToolSchema), collectSchemaCaps(MAP_TOOL.input_schema)),
    ).toEqual([]);
    // Non-vacuous: the caps that used to be un-advertised are present.
    expect(capsFromZodSchema(mapToolSchema).get('topics[].topic')?.maxLength).toBe(80);
    expect(capsFromZodSchema(mapToolSchema).get('topics[].summaryLine')?.maxLength).toBe(200);
  });

  test('merge_topics advertises every constraint the reduce Zod schema enforces', () => {
    expect(
      diffAdvertisedCaps(capsFromZodSchema(reduceToolSchema), collectSchemaCaps(REDUCE_TOOL.input_schema)),
    ).toEqual([]);
    expect(capsFromZodSchema(reduceToolSchema).get('topics[].children[].topic')?.maxLength).toBe(80);
  });
});

describe('cosmetic overruns are clamped, not failed', () => {
  test('an over-long map topic / summaryLine is trimmed on the first attempt', async () => {
    const before = metrics.modelOutputClampedTotal['doc:digest-map'] ?? 0;
    anthropicCreateMock.mockResolvedValue(
      toolResponse(
        'digest_topics',
        mapPayload([{ topic: 't'.repeat(81), summaryLine: 's'.repeat(201), spanRefs: [0, 1] }]),
      ),
    );

    const digest = await buildSourceDigest([docInput('d1')]);

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1); // no retry storm
    expect(digest.topics[0].topic).toHaveLength(80);
    expect(digest.topics[0].summaryLine).toHaveLength(200);
    expect(metrics.modelOutputClampedTotal['doc:digest-map'] ?? 0).toBeGreaterThan(before);
  });

  test('a garbled nodeRef is dropped by the alias lookup instead of failing the reduce', async () => {
    anthropicCreateMock.mockImplementation(async (params: { tools: Array<{ name: string }> }) =>
      params.tools[0].name === 'digest_topics'
        ? toolResponse('digest_topics', mapPayload([{ topic: 'Topic', summaryLine: 'Line', spanRefs: [0] }]))
        : toolResponse('merge_topics', {
            topics: [
              { topic: 'Merged', summaryLine: 'Line', nodeRefs: ['node-0', 'n1'] },
              { topic: 'Invented only', summaryLine: 'Line', nodeRefs: ['nope'] },
            ],
          }),
    );

    const digest = await buildSourceDigest([docInput('d1'), docInput('d2')]);
    // n1 resolved; 'node-0' / 'nope' dropped — the payload was not rejected.
    expect(digest.topics.map((t) => t.topic)).toEqual(['Merged']);
  });

  test('STILL fails when the map payload is structurally wrong (topics is not an array)', async () => {
    anthropicCreateMock.mockResolvedValue(toolResponse('digest_topics', { topics: 'Spaced repetition' }));
    await expect(buildSourceDigest([docInput('d1')])).rejects.toBeInstanceOf(DigestFailedError);
  });
});
