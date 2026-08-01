/**
 * Schema-contract tests for SourceDocumentChunkModel — the Mongo
 * source-of-truth text store for the user-documents RAG corpus,
 * mirroring LessonChunkModel. Pins the chunkType enum validator, the
 * `doc:{courseId}:{docId}:{chunkIndex}` vectorId's unique index (the
 * Pinecone deletion manifest — losing uniqueness orphans vectors), and
 * the wipe-then-write compound index.
 *
 * Run: yarn test SourceDocumentChunkModel
 */

import { describe, test, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import SourceDocumentChunkModel from '@models/SourceDocumentChunkModel';
import { SOURCE_CHUNK_TYPES } from '@lib/constants';

setupTestDb();

beforeAll(async () => {
  await SourceDocumentChunkModel.syncIndexes();
});

const baseChunk = () => {
  const courseId = new mongoose.Types.ObjectId();
  const documentId = new mongoose.Types.ObjectId();
  return {
    userId: new mongoose.Types.ObjectId(),
    courseId,
    documentId,
    chunkIndex: 0,
    chunkType: 'text' as const,
    text: 'Chapter 1 — the fundamentals.',
    vectorId: `doc:${courseId}:${documentId}:0`,
  };
};

describe('SourceDocumentChunkModel', () => {
  test('rejects an invalid chunkType', () => {
    const chunk = new SourceDocumentChunkModel({ ...baseChunk(), chunkType: 'hologram' });
    expect(chunk.validateSync()?.errors.chunkType).toBeDefined();
  });

  test.each([...SOURCE_CHUNK_TYPES])('accepts chunkType %s', (chunkType) => {
    const chunk = new SourceDocumentChunkModel({ ...baseChunk(), chunkType });
    expect(chunk.validateSync()).toBeUndefined();
  });

  test('defaults: headingPath [], pageRange null', async () => {
    const chunk = await SourceDocumentChunkModel.create(baseChunk());
    expect(chunk.headingPath).toEqual([]);
    expect(chunk.pageRange).toBeNull();
  });

  test('vectorId is unique — duplicate insert rejects with E11000', async () => {
    const chunk = baseChunk();
    await SourceDocumentChunkModel.create(chunk);
    await expect(
      SourceDocumentChunkModel.create({ ...baseChunk(), vectorId: chunk.vectorId }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  test('has the unique vectorId index and the wipe-then-write compound index', async () => {
    const indexes = await SourceDocumentChunkModel.collection.indexes();
    const vectorIdx = indexes.find((i) => JSON.stringify(i.key) === JSON.stringify({ vectorId: 1 }));
    expect(vectorIdx?.unique).toBe(true);
    const keys = indexes.map((i) => JSON.stringify(i.key));
    expect(keys).toContain(JSON.stringify({ courseId: 1, documentId: 1, chunkIndex: 1 }));
    expect(keys).toContain(JSON.stringify({ userId: 1 }));
  });
});
