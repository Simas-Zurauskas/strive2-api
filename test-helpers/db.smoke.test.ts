/**
 * Smoke test for the test-helpers themselves. Verifies the in-memory Mongo
 * spins up, factories work, and afterEach cleanup wipes between tests.
 *
 * Run: yarn test test-helpers
 */

import { test, expect } from 'vitest';
import { setupTestDb } from './db';
import { makeUser, makeCourse, makeJob, UserModel, CourseModel, JobModel } from './factories';

setupTestDb();

test('makeUser persists a user with sensible defaults', async () => {
  const user = await makeUser();
  expect(user._id).toBeDefined();
  expect(user.emailVerified).toBe(true);
  expect(user.authProviders).toHaveLength(1);
  expect(user.authProviders[0].provider).toBe('CREDENTIALS');
  expect(user.tokenVersion).toBe(0);
  expect(user.subscription.plan).toBe('free');
  expect(user.credits.allowanceBalance).toBeGreaterThan(0);

  const fetched = await UserModel.findById(user._id);
  expect(fetched).not.toBeNull();
});

test('afterEach wipes collections between tests', async () => {
  // First test created a user. This second test should see none.
  const count = await UserModel.countDocuments();
  expect(count).toBe(0);
});

test('makeCourse + makeJob link a job to a course', async () => {
  const user = await makeUser();
  const course = await makeCourse({ userId: user._id });
  const job = await makeJob({ userId: user._id, courseId: course._id });

  expect(job.status).toBe('pending');
  expect(job.type).toBe('generate_lesson');

  const courseFetched = await CourseModel.findById(course._id);
  expect(courseFetched?.userId.toString()).toBe(user._id.toString());

  const jobFetched = await JobModel.findById(job._id);
  expect(jobFetched?.courseId.toString()).toBe(course._id.toString());
});
