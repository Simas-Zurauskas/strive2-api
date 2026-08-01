/**
 * Tests for the user-document RAG corpus service (Phase 4 of
 * course-from-documents). Pins the load-bearing invariants:
 *
 *   - Chunker: heading-aware merging, table/figure atomicity, overlap.
 *   - vectorId format `doc:{courseId}:{documentId}:{chunkIndex}`.
 *   - Wipe-then-write per document (idempotent re-ingest, no dupes).
 *   - Pinecone upsert BEFORE Mongo insert; abort on Pinecone failure.
 *   - embedBatch call is sliced at ≤ EMBED_BATCH_MAX_INPUTS inputs.
 *   - Search: post-query metadata re-check drops strays; hydration
 *     preserves Pinecone rank via the Map join.
 *   - Deletion reads the Mongo vectorId manifest FIRST and keeps the
 *     manifest when the Pinecone delete fails (no orphaned vectors).
 *
 * Run: yarn test sourceDocRagService
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import SourceDocumentChunkModel from '@models/SourceDocumentChunkModel';
import type { ExtractionBlock } from './documentExtraction';

const { upsertVectorsMock, deleteVectorsByIdsMock, queryVectorsMock, embedBatchMock, embedQueryMock } = vi.hoisted(() => ({
  upsertVectorsMock: vi.fn(),
  deleteVectorsByIdsMock: vi.fn(),
  queryVectorsMock: vi.fn(),
  embedBatchMock: vi.fn(),
  embedQueryMock: vi.fn(),
}));

vi.mock('@lib/pinecone', () => ({
  upsertVectors: upsertVectorsMock,
  deleteVectorsByIds: deleteVectorsByIdsMock,
  queryVectors: queryVectorsMock,
  isPineconeEnabled: () => true,
}));

vi.mock('@lib/openaiEmbeddings', () => ({
  embedBatch: embedBatchMock,
  embedQuery: embedQueryMock,
  isEmbeddingsEnabled: () => true,
}));

import {
  chunkExtractionBlocks,
  buildSourceVectorId,
  indexSourceDocument,
  searchSourceDocuments,
  deleteSourceChunksForCourse,
  deleteSourceChunksForDocument,
  deleteSourceChunksForUser,
  EMBED_BATCH_MAX_INPUTS,
  SOURCE_CHUNK_TARGET_CHARS,
} from './sourceDocRagService';

setupTestDb();

const oid = () => new mongoose.Types.ObjectId();

const fakeEmbedding = () => [0.1, 0.2, 0.3];

beforeEach(() => {
  vi.clearAllMocks();
  upsertVectorsMock.mockResolvedValue(true);
  deleteVectorsByIdsMock.mockResolvedValue(true);
  queryVectorsMock.mockResolvedValue([]);
  embedBatchMock.mockImplementation(async (texts: string[]) => texts.map(() => fakeEmbedding()));
  embedQueryMock.mockResolvedValue(fakeEmbedding());
});

const textBlock = (markdown: string, headingPath: string[] = [], pageRange?: { start: number; end: number }): ExtractionBlock => ({
  type: 'text',
  markdown,
  headingPath,
  ...(pageRange ? { pageRange } : {}),
});

const seedChunk = async (params: {
  userId?: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  documentId: mongoose.Types.ObjectId;
  chunkIndex: number;
  text?: string;
}) => {
  const vectorId = `doc:${params.courseId.toString()}:${params.documentId.toString()}:${params.chunkIndex}`;
  await SourceDocumentChunkModel.create({
    userId: params.userId ?? oid(),
    courseId: params.courseId,
    documentId: params.documentId,
    chunkIndex: params.chunkIndex,
    chunkType: 'text',
    text: params.text ?? `chunk ${params.chunkIndex}`,
    headingPath: [],
    pageRange: null,
    vectorId,
  });
  return vectorId;
};

// ── Chunker ─────────────────────────────────────────────

describe('chunkExtractionBlocks', () => {
  test('small text blocks under the same heading merge into one chunk', () => {
    const blocks = [
      textBlock('First paragraph.', ['Chapter 1']),
      textBlock('Second paragraph.', ['Chapter 1']),
    ];
    const chunks = chunkExtractionBlocks(blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('First paragraph.');
    expect(chunks[0].text).toContain('Second paragraph.');
    expect(chunks[0].headingPath).toEqual(['Chapter 1']);
  });

  test('heading-aware: blocks with different headingPath never merge', () => {
    const blocks = [
      textBlock('Alpha content.', ['Chapter 1']),
      textBlock('Beta content.', ['Chapter 2']),
    ];
    const chunks = chunkExtractionBlocks(blocks);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].headingPath).toEqual(['Chapter 1']);
    expect(chunks[1].headingPath).toEqual(['Chapter 2']);
  });

  test('long text splits near the target size with overlap carried forward', () => {
    const para = 'A sentence of filler text that pads the paragraph out nicely. '.repeat(10).trim(); // ~630 chars
    const blocks = [textBlock([para, para, para, para].join('\n\n'), ['Long'])];
    const chunks = chunkExtractionBlocks(blocks);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(SOURCE_CHUNK_TARGET_CHARS + 700);
    }
    // Overlap: chunk 2 starts with the (trimmed) tail of chunk 1.
    const overlap = chunks[0].text.slice(-150).trimStart();
    expect(overlap.length).toBeGreaterThan(0);
    expect(chunks[1].text.startsWith(overlap.slice(0, 10))).toBe(true);
  });

  test('table blocks stay atomic regardless of length', () => {
    const bigTable = '| a | b |\n|---|---|\n' + '| long row content | more |\n'.repeat(200);
    const blocks: ExtractionBlock[] = [
      textBlock('Intro.', ['H']),
      { type: 'table', markdown: bigTable, headingPath: ['H'] },
      textBlock('Outro.', ['H']),
    ];
    const chunks = chunkExtractionBlocks(blocks);
    const tableChunks = chunks.filter((c) => c.chunkType === 'table');
    expect(tableChunks).toHaveLength(1);
    expect(tableChunks[0].text).toContain('| long row content |');
  });

  test('figure blocks stay atomic and keep their pageRange', () => {
    const blocks: ExtractionBlock[] = [
      { type: 'figure', markdown: '[Figure: a chart]', headingPath: [], pageRange: { start: 3, end: 3 } },
    ];
    const chunks = chunkExtractionBlocks(blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe('figure');
    expect(chunks[0].pageRange).toEqual({ start: 3, end: 3 });
  });
});

// ── vectorId format ─────────────────────────────────────

describe('buildSourceVectorId', () => {
  test('format is doc:{courseId}:{documentId}:{chunkIndex}', () => {
    expect(buildSourceVectorId({ courseId: 'c1', documentId: 'd1', chunkIndex: 4 })).toBe('doc:c1:d1:4');
  });
});

// ── indexSourceDocument ─────────────────────────────────

describe('indexSourceDocument', () => {
  test('writes chunk rows with correctly-formatted vectorIds and user-doc metadata', async () => {
    const userId = oid();
    const courseId = oid();
    const documentId = oid();

    const result = await indexSourceDocument({
      userId: userId.toString(),
      courseId: courseId.toString(),
      documentId: documentId.toString(),
      blocks: [textBlock('Some content worth indexing.', ['Intro'])],
    });

    expect(result.ok).toBe(true);
    const rows = await SourceDocumentChunkModel.find({ documentId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].vectorId).toBe(`doc:${courseId.toString()}:${documentId.toString()}:0`);

    const records = upsertVectorsMock.mock.calls[0][0];
    expect(records[0].metadata).toMatchObject({
      namespace: 'user-doc',
      userId: userId.toString(),
      courseId: courseId.toString(),
      documentId: documentId.toString(),
      chunkIndex: 0,
    });
    expect(upsertVectorsMock.mock.calls[0][1]).toEqual({ action: 'upsert:user-doc' });
  });

  test('wipe-then-write: prior chunks for the document are deleted (vectors first) before re-insert — no dupes on re-ingest', async () => {
    const userId = oid();
    const courseId = oid();
    const documentId = oid();
    const priorVectorId = await seedChunk({ userId, courseId, documentId, chunkIndex: 0, text: 'stale' });

    const result = await indexSourceDocument({
      userId: userId.toString(),
      courseId: courseId.toString(),
      documentId: documentId.toString(),
      blocks: [textBlock('fresh content', [])],
    });

    expect(result.ok).toBe(true);
    expect(deleteVectorsByIdsMock).toHaveBeenCalledWith([priorVectorId], { action: 'delete:user-doc' });
    // Delete happened before the new upsert.
    const deleteOrder = deleteVectorsByIdsMock.mock.invocationCallOrder[0];
    const upsertOrder = upsertVectorsMock.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(upsertOrder);

    const rows = await SourceDocumentChunkModel.find({ documentId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('fresh content');
    // vectorId space converges (unique index would reject dupes anyway).
    const ids = rows.map((r) => r.vectorId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('re-running twice converges: same chunk count, unique vectorIds', async () => {
    const userId = oid();
    const courseId = oid();
    const documentId = oid();
    const blocks = [textBlock('idempotent content', ['H1'])];

    await indexSourceDocument({ userId: userId.toString(), courseId: courseId.toString(), documentId: documentId.toString(), blocks });
    await indexSourceDocument({ userId: userId.toString(), courseId: courseId.toString(), documentId: documentId.toString(), blocks });

    const rows = await SourceDocumentChunkModel.find({ documentId }).lean();
    expect(rows).toHaveLength(1);
  });

  test('Pinecone upsert failure aborts BEFORE the Mongo insert', async () => {
    upsertVectorsMock.mockResolvedValueOnce(false);
    const documentId = oid();

    const result = await indexSourceDocument({
      userId: oid().toString(),
      courseId: oid().toString(),
      documentId: documentId.toString(),
      blocks: [textBlock('content', [])],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('pinecone_failed');
    expect(await SourceDocumentChunkModel.countDocuments({ documentId })).toBe(0);
  });

  test('embed failure aborts with embed_failed and writes nothing', async () => {
    embedBatchMock.mockResolvedValueOnce(null);
    const documentId = oid();

    const result = await indexSourceDocument({
      userId: oid().toString(),
      courseId: oid().toString(),
      documentId: documentId.toString(),
      blocks: [textBlock('content', [])],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('embed_failed');
    expect(upsertVectorsMock).not.toHaveBeenCalled();
    expect(await SourceDocumentChunkModel.countDocuments({ documentId })).toBe(0);
  });

  test(`embedding requests are sliced at ${EMBED_BATCH_MAX_INPUTS} inputs`, async () => {
    // 301 atomic table blocks → 301 chunks → 2 embed calls (300 + 1).
    const blocks: ExtractionBlock[] = Array.from({ length: EMBED_BATCH_MAX_INPUTS + 1 }, (_, i) => ({
      type: 'table' as const,
      markdown: `| row ${i} |`,
      headingPath: [],
    }));

    const result = await indexSourceDocument({
      userId: oid().toString(),
      courseId: oid().toString(),
      documentId: oid().toString(),
      blocks,
    });

    expect(result.ok).toBe(true);
    expect(embedBatchMock).toHaveBeenCalledTimes(2);
    expect(embedBatchMock.mock.calls[0][0]).toHaveLength(EMBED_BATCH_MAX_INPUTS);
    expect(embedBatchMock.mock.calls[1][0]).toHaveLength(1);
  });
});

// ── searchSourceDocuments ───────────────────────────────

describe('searchSourceDocuments', () => {
  test('filters on {namespace, courseId}, drops strays post-query, preserves Pinecone rank', async () => {
    const courseId = oid();
    const otherCourseId = oid();
    const documentId = oid();

    const v0 = await seedChunk({ courseId, documentId, chunkIndex: 0, text: 'zeroth' });
    const v1 = await seedChunk({ courseId, documentId, chunkIndex: 1, text: 'first' });
    const stray = await seedChunk({ courseId: otherCourseId, documentId: oid(), chunkIndex: 0, text: 'foreign' });

    // Pinecone returns rank order [v1, stray, v0] — stray claims a foreign courseId.
    queryVectorsMock.mockResolvedValueOnce([
      { id: v1, score: 0.9, metadata: { namespace: 'user-doc', courseId: courseId.toString(), documentId: documentId.toString(), chunkIndex: 1 } },
      { id: stray, score: 0.8, metadata: { namespace: 'user-doc', courseId: otherCourseId.toString(), documentId: 'x', chunkIndex: 0 } },
      { id: v0, score: 0.7, metadata: { namespace: 'user-doc', courseId: courseId.toString(), documentId: documentId.toString(), chunkIndex: 0 } },
    ]);

    const results = await searchSourceDocuments(courseId.toString(), 'query', { topK: 3 });

    expect(queryVectorsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { namespace: 'user-doc', courseId: courseId.toString() },
        action: 'query:user-doc',
      }),
    );
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('first'); // rank preserved
    expect(results[1].text).toBe('zeroth');
    expect(results.some((r) => r.text === 'foreign')).toBe(false);
  });

  test('documentId option narrows the filter', async () => {
    const courseId = oid();
    const documentId = oid();
    await searchSourceDocuments(courseId.toString(), 'query', { documentId: documentId.toString() });
    expect(queryVectorsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { namespace: 'user-doc', courseId: courseId.toString(), documentId: documentId.toString() },
      }),
    );
  });
});

// ── Deletion (Mongo manifest first) ─────────────────────

describe('deleteSourceChunks*', () => {
  test('deleteSourceChunksForCourse reads vectorIds from Mongo and deletes vectors + rows', async () => {
    const courseId = oid();
    const documentId = oid();
    const v0 = await seedChunk({ courseId, documentId, chunkIndex: 0 });
    const v1 = await seedChunk({ courseId, documentId, chunkIndex: 1 });

    const result = await deleteSourceChunksForCourse(courseId.toString());

    expect(deleteVectorsByIdsMock).toHaveBeenCalledWith(expect.arrayContaining([v0, v1]), { action: 'delete:user-doc' });
    expect(result.chunksDeleted).toBe(2);
    expect(result.vectorsDeleted).toBe(2);
    expect(await SourceDocumentChunkModel.countDocuments({ courseId })).toBe(0);
  });

  test('Pinecone delete failure keeps the Mongo manifest (no permanently-orphaned vectors)', async () => {
    deleteVectorsByIdsMock.mockResolvedValueOnce(false);
    const courseId = oid();
    await seedChunk({ courseId, documentId: oid(), chunkIndex: 0 });

    const result = await deleteSourceChunksForCourse(courseId.toString());

    expect(result.vectorsDeleted).toBe(0);
    // Manifest retained so a retry can still enumerate the vector ids.
    expect(await SourceDocumentChunkModel.countDocuments({ courseId })).toBe(1);
  });

  test('deleteSourceChunksForDocument scopes to one document', async () => {
    const courseId = oid();
    const docA = oid();
    const docB = oid();
    await seedChunk({ courseId, documentId: docA, chunkIndex: 0 });
    await seedChunk({ courseId, documentId: docB, chunkIndex: 0 });

    await deleteSourceChunksForDocument(docA.toString());

    expect(await SourceDocumentChunkModel.countDocuments({ documentId: docA })).toBe(0);
    expect(await SourceDocumentChunkModel.countDocuments({ documentId: docB })).toBe(1);
  });

  test('deleteSourceChunksForUser scopes to one user (FK-drift backstop for account deletion)', async () => {
    const userA = oid();
    const userB = oid();
    await seedChunk({ userId: userA, courseId: oid(), documentId: oid(), chunkIndex: 0 });
    await seedChunk({ userId: userB, courseId: oid(), documentId: oid(), chunkIndex: 0 });

    await deleteSourceChunksForUser(userA.toString());

    expect(await SourceDocumentChunkModel.countDocuments({ userId: userA })).toBe(0);
    expect(await SourceDocumentChunkModel.countDocuments({ userId: userB })).toBe(1);
  });
});
