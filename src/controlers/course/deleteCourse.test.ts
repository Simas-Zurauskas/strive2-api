/**
 * Tests for deleteCourseController — Phase 4 pins that single-course
 * deletion runs BOTH halves of the cleanup split: the content cleanup
 * (regen primitive) AND the source cleanup (documents, chunks, vectors,
 * uploads/ prefix). deleteCourse is the only course-deletion call site and,
 * unlike deleteAccount, has no user-scoped backstop — unswitched it orphans
 * docs/chunks/vectors/S3.
 *
 * Run: yarn test deleteCourse
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import { makeUser, makeCourse, makeJob, CourseModel, JobModel } from '../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../test-helpers/express';

const { fakeCleanupCourse, fakeCleanupSources } = vi.hoisted(() => ({
  fakeCleanupCourse: vi.fn(() => Promise.resolve({})),
  fakeCleanupSources: vi.fn(() => Promise.resolve({ documentsDeleted: 0, chunksDeleted: 0, vectorsDeleted: 0, s3ObjectsDeleted: 0 })),
}));

vi.mock('@services/courseCleanupService', () => ({
  cleanupCourseContent: fakeCleanupCourse,
  cleanupCourseSources: fakeCleanupSources,
  getEditImpact: vi.fn(),
}));

import { deleteCourseController } from './deleteCourse';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deleteCourseController', () => {
  test('runs content cleanup AND source cleanup, deletes jobs + the course row', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await makeJob({ userId: user._id, courseId: course._id });

    const { req, res, status, json } = buildReqRes({
      userId: user._id.toString(),
      params: { id: course._id.toString() },
    });
    await invokeController(deleteCourseController, req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ data: { deleted: true } });

    expect(fakeCleanupCourse).toHaveBeenCalledWith(course._id.toString());
    expect(fakeCleanupSources).toHaveBeenCalledWith({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });
    expect(await CourseModel.countDocuments({ _id: course._id })).toBe(0);
    expect(await JobModel.countDocuments({ courseId: course._id })).toBe(0);
  });
});
