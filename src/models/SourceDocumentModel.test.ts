/**
 * Schema-contract tests for SourceDocumentModel — the per-upload lineage
 * record for course-from-documents (and the erasure manifest for S3 /
 * Pinecone cleanup). Pins the status enum validator, the defaults new
 * rows are created with, and the courseId/userId indexes the cleanup
 * cascades depend on.
 *
 * Run: yarn test SourceDocumentModel
 */

import { describe, test, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import SourceDocumentModel from '@models/SourceDocumentModel';
import { SOURCE_DOCUMENT_STATUSES } from '@lib/constants';

setupTestDb();

beforeAll(async () => {
  await SourceDocumentModel.syncIndexes();
});

const baseDoc = () => ({
  userId: new mongoose.Types.ObjectId(),
  courseId: new mongoose.Types.ObjectId(),
  kind: 'file' as const,
  filename: 'notes.pdf',
  mimeType: 'application/pdf',
  byteSize: 12345,
  sha256: 'a'.repeat(64),
  s3Key: 'uploads/user1/course1/doc1',
});

describe('SourceDocumentModel', () => {
  test('rejects an invalid status', () => {
    const doc = new SourceDocumentModel({ ...baseDoc(), status: 'exploded' });
    const err = doc.validateSync();
    expect(err?.errors.status).toBeDefined();
  });

  test.each([...SOURCE_DOCUMENT_STATUSES])('accepts status %s', (status) => {
    const doc = new SourceDocumentModel({ ...baseDoc(), status });
    expect(doc.validateSync()).toBeUndefined();
  });

  test('rejects an invalid kind', () => {
    const doc = new SourceDocumentModel({ ...baseDoc(), kind: 'carrier_pigeon' });
    expect(doc.validateSync()?.errors.kind).toBeDefined();
  });

  test('requires the identity fields', () => {
    const doc = new SourceDocumentModel({});
    const err = doc.validateSync();
    for (const field of ['userId', 'courseId', 'kind', 'filename', 'mimeType', 'byteSize', 'sha256', 's3Key']) {
      expect(err?.errors[field], `${field} should be required`).toBeDefined();
    }
  });

  test('defaults: status uploaded, warnings/escalatedPages empty, nullable metrics null', async () => {
    const doc = await SourceDocumentModel.create(baseDoc());
    expect(doc.status).toBe('uploaded');
    expect(doc.warnings).toEqual([]);
    expect(doc.escalatedPages).toEqual([]);
    expect(doc.sourceUrl).toBeNull();
    expect(doc.rejectionReason).toBeNull();
    expect(doc.pageCount).toBeNull();
    expect(doc.extractedTokens).toBeNull();
    expect(doc.scannedPageCount).toBeNull();
    expect(doc.audioDurationSec).toBeNull();
    expect(doc.transcribedSec).toBeNull();
    expect(doc.parsedS3Key).toBeNull();
  });

  test('has courseId and userId indexes for the cleanup cascades', async () => {
    const indexes = await SourceDocumentModel.collection.indexes();
    const keys = indexes.map((i) => JSON.stringify(i.key));
    expect(keys).toContain(JSON.stringify({ courseId: 1 }));
    expect(keys).toContain(JSON.stringify({ userId: 1 }));
  });

  test('toJSON strips __v', async () => {
    const doc = await SourceDocumentModel.create(baseDoc());
    expect(doc.toJSON()).not.toHaveProperty('__v');
  });
});
