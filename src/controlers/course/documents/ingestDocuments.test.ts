/**
 * Tests for POST /api/course/:courseId/documents/ingest (Phase 4).
 * Pins: documents-course gate, ≥1 ingestable doc gate, the ≤3 ingest
 * runs / course / day cap (JobModel-counted, approximate under the 24h
 * TTL — over-counting is impossible, under-counting only ever lets an
 * extra run through), and the 202 {jobId} contract via submitJob.
 *
 * Run: yarn test ingestDocuments
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../../../test-helpers/db';
import { makeUser, makeCourse, CourseModel, JobModel } from '../../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../../test-helpers/express';
import SourceDocumentModel from '@models/SourceDocumentModel';
import { AppError } from '@middleware/errorMiddleware';

const { submitJobMock } = vi.hoisted(() => ({ submitJobMock: vi.fn() }));

vi.mock('@services/jobRunner', () => ({
  submitJob: submitJobMock,
}));

import { ingestDocumentsController } from './ingestDocuments';
import { MAX_INGEST_RUNS_PER_DAY } from '@services/documentIngestService';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
  submitJobMock.mockResolvedValue('job-123');
});

const seedDoc = async (params: { userId: mongoose.Types.ObjectId; courseId: mongoose.Types.ObjectId; status?: string }) => {
  const id = new mongoose.Types.ObjectId();
  return SourceDocumentModel.create({
    _id: id,
    userId: params.userId,
    courseId: params.courseId,
    kind: 'file',
    filename: 'a.pdf',
    mimeType: 'application/pdf',
    byteSize: 10,
    sha256: id.toString().padEnd(64, '0'),
    s3Key: `uploads/${params.userId}/${params.courseId}/${id}`,
    status: params.status ?? 'uploaded',
  });
};

const makeDocsCourse = async (userId: mongoose.Types.ObjectId) => {
  const course = await makeCourse({ userId, status: 'creating' });
  await CourseModel.updateOne({ _id: course._id }, { $set: { source: 'documents' } });
  return course;
};

const invoke = (params: { userId: string; courseId: string }) => {
  const { req, res, status, json } = buildReqRes({
    userId: params.userId,
    params: { courseId: params.courseId },
  });
  return { run: () => invokeController(ingestDocumentsController, req, res), status, json };
};

describe('ingestDocumentsController', () => {
  test('202 {jobId}: submits an ingest_documents job for a documents course with an uploaded doc', async () => {
    const user = await makeUser();
    const course = await makeDocsCourse(user._id);
    await seedDoc({ userId: user._id, courseId: course._id });

    const { run, status, json } = invoke({ userId: user._id.toString(), courseId: course._id.toString() });
    await run();

    expect(submitJobMock).toHaveBeenCalledWith({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      type: 'ingest_documents',
    });
    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ data: { jobId: 'job-123' } });
  });

  test('failed and stale-parsing docs count as ingestable (crashed-run recovery)', async () => {
    const user = await makeUser();
    const course = await makeDocsCourse(user._id);
    await seedDoc({ userId: user._id, courseId: course._id, status: 'failed' });

    const { run, status } = invoke({ userId: user._id.toString(), courseId: course._id.toString() });
    await run();
    expect(status).toHaveBeenCalledWith(202);
  });

  test('400 on a goal-based course (no source documents to ingest)', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await seedDoc({ userId: user._id, courseId: course._id });

    const { run } = invoke({ userId: user._id.toString(), courseId: course._id.toString() });
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  test('400 when no document is in an ingestable state', async () => {
    const user = await makeUser();
    const course = await makeDocsCourse(user._id);
    await seedDoc({ userId: user._id, courseId: course._id, status: 'parsed' });
    await seedDoc({ userId: user._id, courseId: course._id, status: 'rejected' });

    const { run } = invoke({ userId: user._id.toString(), courseId: course._id.toString() });
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  test(`daily cap: the ${MAX_INGEST_RUNS_PER_DAY + 1}th run in 24h is a 400 DOCUMENT_LIMIT_EXCEEDED with meta`, async () => {
    const user = await makeUser();
    const course = await makeDocsCourse(user._id);
    await seedDoc({ userId: user._id, courseId: course._id });

    for (let i = 0; i < MAX_INGEST_RUNS_PER_DAY; i++) {
      await JobModel.create({
        userId: user._id,
        courseId: course._id,
        type: 'ingest_documents',
        status: 'completed',
        completedAt: new Date(),
      });
    }

    const { run } = invoke({ userId: user._id.toString(), courseId: course._id.toString() });
    let thrown: unknown;
    try {
      await run();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).errorCode).toBe('DOCUMENT_LIMIT_EXCEEDED');
    expect((thrown as AppError).statusCode).toBe(400);
    expect((thrown as AppError).meta).toMatchObject({ limit: MAX_INGEST_RUNS_PER_DAY });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  test('runs older than 24h do not count toward the cap', async () => {
    const user = await makeUser();
    const course = await makeDocsCourse(user._id);
    await seedDoc({ userId: user._id, courseId: course._id });

    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (let i = 0; i < MAX_INGEST_RUNS_PER_DAY; i++) {
      const job = await JobModel.create({
        userId: user._id,
        courseId: course._id,
        type: 'ingest_documents',
        status: 'completed',
        completedAt: old,
      });
      // timestamps:true stamps createdAt=now on create — backdate directly.
      await JobModel.collection.updateOne({ _id: job._id }, { $set: { createdAt: old } });
    }

    const { run, status } = invoke({ userId: user._id.toString(), courseId: course._id.toString() });
    await run();
    expect(status).toHaveBeenCalledWith(202);
  });

  test('other job types on the course do not count toward the ingest cap', async () => {
    const user = await makeUser();
    const course = await makeDocsCourse(user._id);
    await seedDoc({ userId: user._id, courseId: course._id });

    for (let i = 0; i < MAX_INGEST_RUNS_PER_DAY; i++) {
      await JobModel.create({
        userId: user._id,
        courseId: course._id,
        type: 'generate_lesson',
        status: 'completed',
        completedAt: new Date(),
      });
    }

    const { run, status } = invoke({ userId: user._id.toString(), courseId: course._id.toString() });
    await run();
    expect(status).toHaveBeenCalledWith(202);
  });
});
