/**
 * Job-level tests for the `prepare_corpus` case (Phase 5):
 *
 *   1. THE DEBIT RULE (PLAN §3.4): a successful prepare_corpus job DOES
 *      call `debitActualSpend` — it takes the normal success-path debit,
 *      unlike `ingest_documents` which is exempt (pinned side-by-side).
 *   2. Failed prepare_corpus (e.g. CONTENT_REJECTED) never debits, and
 *      the errorCode + meta surface on the terminal `update` socket
 *      payload (the plan's nothing-debited-for-unconsumed-work rule).
 *   3. The source gate: prepare_corpus on a non-documents course fails.
 *
 * Run: yarn test jobRunner.prepareCorpus
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, makeJob, CourseModel, JobModel } from '../../test-helpers/factories';
import { AppError } from '@middleware/errorMiddleware';

const { runPrepareCorpusMock, runIngestMock, debitMock, determineBucketMock } = vi.hoisted(() => ({
  runPrepareCorpusMock: vi.fn(),
  runIngestMock: vi.fn(),
  debitMock: vi.fn(),
  determineBucketMock: vi.fn(),
}));

vi.mock('@services/corpusPreparationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/corpusPreparationService')>();
  return { ...actual, runPrepareCorpus: runPrepareCorpusMock };
});

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
  runPrepareCorpusMock.mockResolvedValue(undefined);
  runIngestMock.mockResolvedValue(undefined);
  debitMock.mockResolvedValue(undefined);
  determineBucketMock.mockResolvedValue('allowance');
});

const captureUpdates = () => {
  const updates: Array<Record<string, unknown>> = [];
  const listener = (payload: Record<string, unknown>) => updates.push(payload);
  jobEvents.on('update', listener);
  return { updates, stop: () => jobEvents.off('update', listener) };
};

describe('processJob — prepare_corpus debits, ingest does not (PLAN §3.4)', () => {
  test('successful prepare_corpus job calls debitActualSpend once', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    await CourseModel.updateOne({ _id: course._id }, { $set: { source: 'documents' } });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'prepare_corpus' });

    const { updates, stop } = captureUpdates();
    await processJob(job._id.toString());
    stop();

    expect(runPrepareCorpusMock).toHaveBeenCalledTimes(1);
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(debitMock.mock.calls[0][0]).toMatchObject({ jobType: 'prepare_corpus' });

    expect((await JobModel.findById(job._id).lean())?.status).toBe('completed');
    expect(updates.at(-1)).toMatchObject({ status: 'completed', type: 'prepare_corpus' });
  });

  test('control pair: a successful ingest_documents job does NOT debit', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    await CourseModel.updateOne({ _id: course._id }, { $set: { source: 'documents' } });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'ingest_documents' });

    await processJob(job._id.toString());

    expect(runIngestMock).toHaveBeenCalledTimes(1);
    expect(debitMock).not.toHaveBeenCalled();
    expect((await JobModel.findById(job._id).lean())?.status).toBe('completed');
  });

  test('failed prepare_corpus (CONTENT_REJECTED) never debits; errorCode + meta reach the socket payload', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    await CourseModel.updateOne({ _id: course._id }, { $set: { source: 'documents' } });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'prepare_corpus' });

    runPrepareCorpusMock.mockRejectedValueOnce(
      new AppError('Policy-violating content was found in the fully-extracted material.', {
        errorCode: 'CONTENT_REJECTED',
        statusCode: 400,
        meta: { rejected: 1, failed: 0, prepared: 2 },
      }),
    );

    const { updates, stop } = captureUpdates();
    await processJob(job._id.toString());
    stop();

    expect(debitMock).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      status: 'failed',
      type: 'prepare_corpus',
      errorCode: 'CONTENT_REJECTED',
      errorMeta: { rejected: 1, failed: 0, prepared: 2 },
    });
    expect((await JobModel.findById(job._id).lean())?.status).toBe('failed');
  });

  test('prepare_corpus on a non-documents course fails with the source gate', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'prepare_corpus' });

    await processJob(job._id.toString());

    expect(runPrepareCorpusMock).not.toHaveBeenCalled();
    expect(debitMock).not.toHaveBeenCalled();
    const jobAfter = await JobModel.findById(job._id).lean();
    expect(jobAfter?.status).toBe('failed');
    expect(jobAfter?.error).toMatch(/only available for courses created from documents/);
  });
});
