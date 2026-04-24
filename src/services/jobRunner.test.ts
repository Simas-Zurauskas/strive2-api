/**
 * Tests for the jobRunner concurrency-guard surface (`submitJob`). The two
 * race-prone paths are:
 *
 *   1. Pre-flight gate rollback — credit-out or concurrency-cap rejections
 *      must delete the orphan Job row so the next submitJob doesn't see a
 *      ghost row.
 *   2. Atomic activeJobId claim — only one of N concurrent submitJob calls
 *      on the same course can win; losers get an error AND have their orphan
 *      Job row cleaned up.
 *
 * pLimit is mocked to no-op so the asynchronous `processJob` callback never
 * runs (which would pull in real LLM agents). The test only exercises the
 * synchronous claim/rollback logic — the per-job execution path itself is
 * out of scope here (and impossible to test without mocking every agent).
 *
 * Run: yarn test jobRunner
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, UserModel, CourseModel, JobModel } from '../../test-helpers/factories';
import { PLANS } from '@lib/creditPricing';

// Mock pLimit so jobLimit(fn) doesn't actually invoke the worker fn (which
// would require LLM agents, sockets, S3, etc.). Returning a function that
// resolves immediately gives submitJob the "scheduled" semantics it needs
// without firing the work.
vi.mock('p-limit', () => ({
  default: () => (_fn: unknown) => Promise.resolve(),
}));

vi.mock('@services/creditService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/creditService')>();
  return {
    ...actual,
    getBalance: vi.fn(),
  };
});

import { submitJob } from '@services/jobRunner';
import { getBalance, InsufficientCreditsError, MaxConcurrentJobsError } from '@services/creditService';

const mockedGetBalance = vi.mocked(getBalance);

setupTestDb();

beforeEach(() => {
  mockedGetBalance.mockReset();
  // Default: caller has enough credits.
  mockedGetBalance.mockResolvedValue({
    allowance: 100,
    bonus: 0,
    total: 100,
    periodStart: new Date(),
    periodEnd: new Date(),
    plan: 'free',
  });
});

// ── submitJob happy path ───────────────────────────────

describe('submitJob happy path', () => {
  test('creates Job row, claims activeJobId, returns the jobId', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    const jobId = await submitJob({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      type: 'generate_lesson',
    });

    expect(jobId).toBeTruthy();
    const job = await JobModel.findById(jobId).lean();
    assert(job);
    expect(job.status).toBe('pending');
    expect(job.userId.toString()).toBe(user._id.toString());

    const claimed = await CourseModel.findById(course._id).lean();
    expect(claimed?.activeJobId?.toString()).toBe(jobId);
  });

  test('preserves metadata (e.g. moduleIndex/lessonIndex on generate_lesson)', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    const jobId = await submitJob({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      type: 'generate_lesson',
      metadata: { moduleIndex: 2, lessonIndex: 3 },
    });

    const job = await JobModel.findById(jobId).lean();
    expect(job?.metadata).toEqual({ moduleIndex: 2, lessonIndex: 3 });
  });
});

// ── Pre-flight gate rollback ───────────────────────────

describe('submitJob pre-flight gate rollback', () => {
  test('balance < 1: throws InsufficientCreditsError, deletes the orphan Job row', async () => {
    mockedGetBalance.mockResolvedValueOnce({
      allowance: 0,
      bonus: 0,
      total: 0,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'free',
    });
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    await expect(
      submitJob({
        userId: user._id.toString(),
        courseId: course._id.toString(),
        type: 'generate_lesson',
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(await JobModel.countDocuments()).toBe(0);
    const courseAfter = await CourseModel.findById(course._id).lean();
    expect(courseAfter?.activeJobId).toBeFalsy();
  });

  test('per-user concurrency cap reached: throws MaxConcurrentJobsError, deletes orphan', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const limit = PLANS.free.maxConcurrentJobs;

    // Pre-seed `limit` jobs in pending state for this user
    for (let i = 0; i < limit; i++) {
      await JobModel.create({
        userId: user._id,
        courseId: course._id,
        type: 'generate_lesson',
        status: 'pending',
      });
    }
    const before = await JobModel.countDocuments();

    await expect(
      submitJob({
        userId: user._id.toString(),
        courseId: course._id.toString(),
        type: 'generate_lesson',
      }),
    ).rejects.toBeInstanceOf(MaxConcurrentJobsError);

    // The new orphan was rolled back; pre-seeded count is unchanged.
    expect(await JobModel.countDocuments()).toBe(before);
  });

  test('concurrency cap counts only pending+processing (not completed/failed)', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const limit = PLANS.free.maxConcurrentJobs;

    // `limit` completed jobs shouldn't block a new submit
    for (let i = 0; i < limit; i++) {
      await JobModel.create({
        userId: user._id,
        courseId: course._id,
        type: 'generate_lesson',
        status: 'completed',
        completedAt: new Date(),
      });
    }

    const jobId = await submitJob({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      type: 'generate_lesson',
    });
    expect(jobId).toBeTruthy();
  });
});

// ── Atomic activeJobId claim race ───────────────────────

describe('submitJob atomic activeJobId claim', () => {
  test('two concurrent submits on same course: only one wins, the other is rolled back', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    const results = await Promise.allSettled([
      submitJob({
        userId: user._id.toString(),
        courseId: course._id.toString(),
        type: 'generate_lesson',
      }),
      submitJob({
        userId: user._id.toString(),
        courseId: course._id.toString(),
        type: 'generate_lesson',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('already running');

    // Exactly one Job row survives.
    expect(await JobModel.countDocuments()).toBe(1);

    const claimed = await CourseModel.findById(course._id).lean();
    const winnerJobId = (fulfilled[0] as PromiseFulfilledResult<string>).value;
    expect(claimed?.activeJobId?.toString()).toBe(winnerJobId);
  });

  test('course already locked (activeJobId set): submit rejects + rolls back orphan', async () => {
    const user = await makeUser();
    const course = await makeCourse({
      userId: user._id,
      activeJobId: new mongoose.Types.ObjectId(),
    });

    await expect(
      submitJob({
        userId: user._id.toString(),
        courseId: course._id.toString(),
        type: 'generate_lesson',
      }),
    ).rejects.toThrow('already running');

    // Orphan Job row from this attempt is gone.
    expect(await JobModel.countDocuments()).toBe(0);
  });

  test('after a job finishes: a new submit can claim again', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    const first = await submitJob({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      type: 'generate_lesson',
    });

    // Simulate the job finishing — clear activeJobId + mark Job completed
    await CourseModel.updateOne({ _id: course._id }, { $set: { activeJobId: null } });
    await JobModel.updateOne(
      { _id: first },
      { $set: { status: 'completed', completedAt: new Date() } },
    );

    const second = await submitJob({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      type: 'generate_lesson',
    });
    expect(second).not.toBe(first);

    const claimed = await CourseModel.findById(course._id).lean();
    expect(claimed?.activeJobId?.toString()).toBe(second);
  });
});
