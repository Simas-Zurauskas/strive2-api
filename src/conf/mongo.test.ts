/**
 * Tests for the boot-time orphan-job reaper. Verifies that on a fresh boot
 * after a crash:
 *   - All `pending`/`processing` Job rows are flipped to `failed`
 *   - All Course.activeJobId / activeLesson pointers are cleared
 *   - Incomplete LessonContent rows are deleted (and S3 cleanup is fired)
 *   - Already-completed jobs are untouched
 *
 * Strategy:
 *   - In-memory Mongo for real model writes
 *   - Mock S3 deleteByPrefix so we don't hit AWS (and assert it's invoked)
 *
 * Run: yarn test mongo
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, makeJob, makeLessonContent, JobModel, CourseModel, LessonContentModel } from '../../test-helpers/factories';

vi.mock('@services/s3Service', () => ({
  deleteByPrefix: vi.fn(() => Promise.resolve()),
  uploadBuffer: vi.fn(),
  getPresignedUrl: vi.fn(),
  objectExists: vi.fn(),
}));

import { cleanupOrphanedJobs } from '@conf/mongo';
import { deleteByPrefix } from '@services/s3Service';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cleanupOrphanedJobs', () => {
  test('flips pending + processing jobs to failed, leaves completed/failed untouched', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    await makeJob({ userId: user._id, courseId: course._id, status: 'pending' });
    await makeJob({ userId: user._id, courseId: course._id, status: 'processing' });
    await makeJob({
      userId: user._id,
      courseId: course._id,
      status: 'completed',
      completedAt: new Date(),
    });
    await makeJob({
      userId: user._id,
      courseId: course._id,
      status: 'failed',
      error: 'pre-existing failure',
      completedAt: new Date(),
    });

    await cleanupOrphanedJobs();

    const failedFromReaper = await JobModel.find({ error: 'Server restarted during processing' }).lean();
    expect(failedFromReaper).toHaveLength(2);

    const completedAfter = await JobModel.find({ status: 'completed' }).lean();
    expect(completedAfter).toHaveLength(1); // untouched

    const oldFailed = await JobModel.find({ error: 'pre-existing failure' }).lean();
    expect(oldFailed).toHaveLength(1); // untouched
  });

  test('clears Course.activeJobId AND activeLesson on every locked course', async () => {
    const user = await makeUser();
    const ghostJobId = new mongoose.Types.ObjectId();

    const c1 = await makeCourse({
      userId: user._id,
      activeJobId: ghostJobId,
      activeLesson: { moduleIndex: 1, lessonIndex: 2 },
    });
    const c2 = await makeCourse({
      userId: user._id,
      activeJobId: ghostJobId,
      activeLesson: null,
    });
    const c3 = await makeCourse({ userId: user._id }); // never locked
    await CourseModel.updateOne({ _id: c3._id }, { $set: { activeLesson: null } });

    await cleanupOrphanedJobs();

    const a1 = await CourseModel.findById(c1._id).lean();
    expect(a1?.activeJobId).toBeFalsy();
    expect(a1?.activeLesson).toBeNull();

    const a2 = await CourseModel.findById(c2._id).lean();
    expect(a2?.activeJobId).toBeFalsy();

    // c3 was never locked; the bulk update only touches courses with non-null
    // pointers, so its lastModifiedAt should not have changed (we don't assert
    // that directly, just that the row exists and its activeJobId stays null).
    const a3 = await CourseModel.findById(c3._id).lean();
    expect(a3?.activeJobId).toBeFalsy();
  });

  test('deletes incomplete LessonContent rows + fires S3 deleteByPrefix per row', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    // 2 incomplete rows + 1 complete row
    await makeLessonContent({
      courseId: course._id,
      moduleIndex: 0,
      lessonIndex: 0,
      completed: false,
    });
    await makeLessonContent({
      courseId: course._id,
      moduleIndex: 1,
      lessonIndex: 1,
      completed: false,
    });
    await makeLessonContent({
      courseId: course._id,
      moduleIndex: 2,
      lessonIndex: 2,
      completed: true,
    });

    await cleanupOrphanedJobs();

    // Only the completed row remains
    const after = await LessonContentModel.find().lean();
    expect(after).toHaveLength(1);
    expect(after[0].completed).toBe(true);

    // S3 cleanup fired for each incomplete row
    expect(deleteByPrefix).toHaveBeenCalledTimes(2);
    expect(deleteByPrefix).toHaveBeenCalledWith(`lessons/${course._id}/0/0/`);
    expect(deleteByPrefix).toHaveBeenCalledWith(`lessons/${course._id}/1/1/`);
  });

  test('S3 cleanup throwing on one row does NOT block other deletions', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await makeLessonContent({
      courseId: course._id,
      moduleIndex: 0,
      lessonIndex: 0,
      completed: false,
    });
    await makeLessonContent({
      courseId: course._id,
      moduleIndex: 1,
      lessonIndex: 1,
      completed: false,
    });

    vi.mocked(deleteByPrefix)
      .mockRejectedValueOnce(new Error('S3 unreachable'))
      .mockResolvedValueOnce(undefined);

    await cleanupOrphanedJobs();
    // Both LessonContent rows still get deleted from Mongo even though S3
    // threw on the first one — the bgError catch keeps the loop alive.
    expect(await LessonContentModel.countDocuments()).toBe(0);
  });

  test('idempotent: a second call is a no-op (no new rows changed)', async () => {
    const user = await makeUser();
    const course = await makeCourse({
      userId: user._id,
      activeJobId: new mongoose.Types.ObjectId(),
    });
    await makeJob({ userId: user._id, courseId: course._id, status: 'pending' });

    await cleanupOrphanedJobs();
    // After first call: job marked failed, course unlocked, no incomplete rows
    const jobsAfterFirst = await JobModel.find().lean();
    expect(jobsAfterFirst).toHaveLength(1);
    expect(jobsAfterFirst[0].status).toBe('failed');

    // Second call: nothing more to do
    await cleanupOrphanedJobs();
    const jobsAfterSecond = await JobModel.find().lean();
    expect(jobsAfterSecond).toHaveLength(1);
    expect(jobsAfterSecond[0].status).toBe('failed');
  });

  test('empty database: clean run, no errors', async () => {
    await expect(cleanupOrphanedJobs()).resolves.toBeUndefined();
  });
});
