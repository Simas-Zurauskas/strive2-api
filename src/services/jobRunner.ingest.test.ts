/**
 * Job-level tests for the `ingest_documents` case (Phase 4):
 *
 *   1. NO-DEBIT RULE (PLAN §3.4): a successful ingest job never calls
 *      `debitActualSpend`; every other job type still does (clarify pinned
 *      as the control).
 *   2. CONTENT_REJECTED propagation: an ingest failure carrying
 *      errorCode/meta surfaces both on the terminal `update` socket payload
 *      (jobRunner error propagation contract).
 *   3. THE CLARIFY-RESET TRAP: clarify's downstream reset + regen
 *      `cleanupCourseContent` must NOT touch the new source fields or the
 *      document corpus (sourceDigest / sourceAssessment / SourceDocument /
 *      SourceDocumentChunk survive a clarify run).
 *
 * Run: yarn test jobRunner.ingest
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, makeJob, CourseModel, JobModel } from '../../test-helpers/factories';
import SourceDocumentModel from '@models/SourceDocumentModel';
import SourceDocumentChunkModel from '@models/SourceDocumentChunkModel';
import { AppError } from '@middleware/errorMiddleware';

const { runIngestMock, debitMock, determineBucketMock, classifyMock, clarifyMock } = vi.hoisted(() => ({
  runIngestMock: vi.fn(),
  debitMock: vi.fn(),
  determineBucketMock: vi.fn(),
  classifyMock: vi.fn(),
  clarifyMock: vi.fn(),
}));

vi.mock('@services/documentIngestService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/documentIngestService')>();
  return { ...actual, runIngestDocuments: runIngestMock };
});

vi.mock('@services/creditService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/creditService')>();
  return {
    ...actual,
    debitActualSpend: debitMock,
    determineCreditBucket: determineBucketMock,
  };
});

vi.mock('@services/courseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/courseService')>();
  return {
    ...actual,
    classifyGoalType: classifyMock,
    clarifyCourse: clarifyMock,
  };
});

vi.mock('@services/s3Service', () => ({
  deleteByPrefix: vi.fn(() => Promise.resolve(0)),
  uploadBuffer: vi.fn(),
  getPresignedUrl: vi.fn(),
  objectExists: vi.fn(),
  copyObject: vi.fn(),
  deleteObject: vi.fn(),
  getObjectBuffer: vi.fn(),
  listKeysByPrefix: vi.fn(() => Promise.resolve([])),
  resolveImageUrl: vi.fn(),
}));

import { processJob } from '@services/jobRunner';
import { jobEvents } from '@services/jobEvents';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
  runIngestMock.mockResolvedValue(undefined);
  debitMock.mockResolvedValue(undefined);
  determineBucketMock.mockResolvedValue('allowance');
  classifyMock.mockResolvedValue({ goalType: 'master', confidence: 'medium', noun: 'thing' });
  clarifyMock.mockResolvedValue({ questions: [] });
});

const captureUpdates = () => {
  const updates: Array<Record<string, unknown>> = [];
  const listener = (payload: Record<string, unknown>) => updates.push(payload);
  jobEvents.on('update', listener);
  return { updates, stop: () => jobEvents.off('update', listener) };
};

const seedSources = async (params: { userId: mongoose.Types.ObjectId; courseId: mongoose.Types.ObjectId }) => {
  const documentId = new mongoose.Types.ObjectId();
  await SourceDocumentModel.create({
    _id: documentId,
    userId: params.userId,
    courseId: params.courseId,
    kind: 'file',
    filename: 'a.pdf',
    mimeType: 'application/pdf',
    byteSize: 10,
    sha256: 'a'.repeat(64),
    s3Key: `uploads/${params.userId.toString()}/${params.courseId.toString()}/${documentId.toString()}`,
    status: 'parsed',
  });
  await SourceDocumentChunkModel.create({
    userId: params.userId,
    courseId: params.courseId,
    documentId,
    chunkIndex: 0,
    chunkType: 'text',
    text: 'chunk zero',
    headingPath: [],
    pageRange: null,
    vectorId: `doc:${params.courseId.toString()}:${documentId.toString()}:0`,
  });
  await CourseModel.updateOne(
    { _id: params.courseId },
    {
      $set: {
        source: 'documents',
        sourceAssessment: { topics: ['t'], warnings: [] },
        sourceDigest: { topics: [{ topic: 't', spanRefs: [], docIds: [] }] },
      },
    },
  );
  return documentId;
};

describe('processJob — ingest_documents no-debit rule (PLAN §3.4)', () => {
  test('successful ingest job completes WITHOUT calling debitActualSpend', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    await CourseModel.updateOne({ _id: course._id }, { $set: { source: 'documents' } });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'ingest_documents' });

    const { updates, stop } = captureUpdates();
    await processJob(job._id.toString());
    stop();

    expect(runIngestMock).toHaveBeenCalledTimes(1);
    expect(debitMock).not.toHaveBeenCalled();

    const jobAfter = await JobModel.findById(job._id).lean();
    expect(jobAfter?.status).toBe('completed');
    expect(updates.at(-1)).toMatchObject({ status: 'completed', type: 'ingest_documents' });
  });

  test('control: a successful clarify job still debits', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'clarify' });

    await processJob(job._id.toString());

    expect(debitMock).toHaveBeenCalledTimes(1);
    expect((await JobModel.findById(job._id).lean())?.status).toBe('completed');
  });
});

describe('processJob — CONTENT_REJECTED propagation', () => {
  test('ingest failure carries errorCode + errorMeta on the terminal update payload', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    await CourseModel.updateOne({ _id: course._id }, { $set: { source: 'documents' } });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'ingest_documents' });

    runIngestMock.mockRejectedValueOnce(
      new AppError('All documents were rejected or failed.', {
        errorCode: 'CONTENT_REJECTED',
        statusCode: 400,
        meta: { rejected: 2, failed: 1 },
      }),
    );

    const { updates, stop } = captureUpdates();
    await processJob(job._id.toString());
    stop();

    expect(debitMock).not.toHaveBeenCalled(); // failed jobs never debit anyway
    const terminal = updates.at(-1);
    expect(terminal).toMatchObject({
      status: 'failed',
      errorCode: 'CONTENT_REJECTED',
      errorMeta: { rejected: 2, failed: 1 },
    });
    expect((await JobModel.findById(job._id).lean())?.status).toBe('failed');
  });
});

describe('processJob — clarify reset does not touch the document corpus (the trap)', () => {
  test('sourceDigest / sourceAssessment / SourceDocument / chunks all survive a clarify run', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating', depth: 'comprehensive' });
    const documentId = await seedSources({ userId: user._id, courseId: course._id });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'clarify' });

    await processJob(job._id.toString());

    expect((await JobModel.findById(job._id).lean())?.status).toBe('completed');

    const courseAfter = await CourseModel.findById(course._id).lean();
    // The clarify downstream reset fired…
    expect(courseAfter?.depth).toBeNull();
    expect(courseAfter?.structure).toBeNull();
    // …but the source fields survived.
    expect(courseAfter?.source).toBe('documents');
    expect(courseAfter?.sourceAssessment).toMatchObject({ topics: ['t'] });
    expect(courseAfter?.sourceDigest).toMatchObject({ topics: [{ topic: 't' }] });

    // The corpus rows survived the regen cleanupCourseContent.
    expect(await SourceDocumentModel.countDocuments({ courseId: course._id })).toBe(1);
    expect(await SourceDocumentChunkModel.countDocuments({ documentId })).toBe(1);
  });
});
