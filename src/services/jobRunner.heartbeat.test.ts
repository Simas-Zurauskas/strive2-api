/**
 * `processJob`'s heartbeat lifecycle — the other half of the stuck-job story.
 *
 * The watchdog (`jobRunner.watchdog.test.ts`) reaps `processing` rows whose
 * `lastHeartbeat` is older than 120s. That is only safe if a *healthy* job
 * keeps its heartbeat warm. Two production bugs live in the gap:
 *
 *   1. **The 30s heartbeat interval stops firing** (removed, or moved inside
 *      a branch that non-streaming job types skip). Every clarify /
 *      refine_structure / regenerate_* job then looks stuck to the watchdog
 *      at the 2-minute mark and is killed mid-flight — the user loses the
 *      work AND the credits already spent on it, and the failure reads as
 *      "Stuck job (no heartbeat)" on a job that was running perfectly.
 *   2. **The interval is not cleared in `finally`.** The timer then outlives
 *      the job and keeps stamping `lastHeartbeat` on a completed row forever,
 *      one leaked timer per job, for the life of the process.
 *
 * Both are asserted on the stored document, not on a spy: test (2) advances
 * the clock five minutes AFTER the job has finished and asserts
 * `lastHeartbeat` is still `null` — a leaked interval would have re-stamped
 * it with a Date.
 *
 * Only `setInterval`/`clearInterval` are faked. A blanket
 * `vi.useFakeTimers()` would freeze `setTimeout`, which the MongoDB driver
 * uses for server selection, and every query in this file would hang.
 *
 * Run: yarn test jobRunner.heartbeat
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { debitMock, determineBucketMock, classifyMock, clarifyMock, cleanupMock } = vi.hoisted(() => ({
  debitMock: vi.fn(),
  determineBucketMock: vi.fn(),
  classifyMock: vi.fn(),
  clarifyMock: vi.fn(),
  cleanupMock: vi.fn(),
}));

vi.mock('@services/creditService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/creditService')>();
  return { ...actual, debitActualSpend: debitMock, determineCreditBucket: determineBucketMock };
});

vi.mock('@services/courseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/courseService')>();
  return {
    ...actual,
    classifyGoalType: classifyMock,
    clarifyCourse: clarifyMock,
    cleanupCourseContent: cleanupMock,
  };
});

import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, makeJob, CourseModel, JobModel } from '../../test-helpers/factories';
import { processJob } from '@services/jobRunner';

setupTestDb();

const HEARTBEAT_INTERVAL_MS = 30_000;

const waitFor = async (predicate: () => Promise<boolean>, label: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
};

/**
 * A clarify job whose agent work this test controls the completion of.
 * `release()` waits for the agent to actually be invoked first — the job is
 * stamped `processing` several awaits before `clarifyCourse` is reached, so
 * a naive release races the thing it is trying to unblock.
 */
const deferredClarify = () => {
  let resolveFn: ((value: unknown) => void) | null = null;
  clarifyMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
  );
  return {
    release: async () => {
      await waitFor(async () => resolveFn !== null, 'clarifyCourse invoked');
      resolveFn!({ questions: [] });
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  debitMock.mockResolvedValue(undefined);
  determineBucketMock.mockResolvedValue('allowance');
  classifyMock.mockResolvedValue({ goalType: 'master', confidence: 'medium', noun: 'thing' });
  clarifyMock.mockResolvedValue({ questions: [] });
  cleanupMock.mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  // Registered after setupTestDb()'s afterEach; vitest runs afterEach hooks
  // LIFO, so real timers are back before the collection cleanup runs.
  vi.useRealTimers();
});

describe('processJob — heartbeat while the job runs', () => {
  test('the job is stamped `processing` with a lastHeartbeat before any agent work starts', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'clarify' });
    expect((await JobModel.findById(job._id).lean())?.lastHeartbeat).toBeNull();

    const gate = deferredClarify();
    const run = processJob(job._id.toString());

    await waitFor(async () => (await JobModel.findById(job._id).lean())?.status === 'processing', 'job marked processing');
    const midFlight = await JobModel.findById(job._id).lean();
    expect(midFlight?.lastHeartbeat).toBeInstanceOf(Date);

    await gate.release();
    await run;
  });

  test('the 30s interval keeps the heartbeat warm for a long-running job', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'clarify' });

    const gate = deferredClarify();
    const run = processJob(job._id.toString());

    await waitFor(async () => (await JobModel.findById(job._id).lean())?.lastHeartbeat != null, 'initial heartbeat');
    const first = (await JobModel.findById(job._id).lean())!.lastHeartbeat!;

    // Real time must move so the second stamp is strictly later; the clock
    // itself is NOT faked, only setInterval is.
    await new Promise((r) => setTimeout(r, 5));

    // Advance inside the poll loop rather than once. `lastHeartbeat` is
    // written one statement BEFORE `setInterval` is called, so a single
    // advance can land in the window where this test has already observed
    // the stamp but `processJob` has not yet registered the interval — the
    // advance then fires nothing and the fake clock never moves again.
    // Repeating cannot make a broken implementation pass: if the interval
    // never writes, the predicate never holds. (Verified by mutation:
    // deleting the heartbeat write inside the interval fails this test.)
    await waitFor(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      return ((await JobModel.findById(job._id).lean())?.lastHeartbeat?.getTime() ?? 0) > first.getTime();
    }, 'heartbeat refreshed by the interval');

    await gate.release();
    await run;
  });
});

describe('processJob — the finally block', () => {
  test('the heartbeat interval is cleared when the job completes — no timer outlives the job', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'clarify' });

    await processJob(job._id.toString());

    const finished = await JobModel.findById(job._id).lean();
    expect(finished?.status).toBe('completed');
    expect(finished?.lastHeartbeat).toBeNull();

    // The assertion that a spy could not make: five minutes of interval
    // ticks after the job is done. A leaked timer would re-stamp
    // `lastHeartbeat` with a Date and — worse — keep a completed job looking
    // alive to anything reading that field.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 10);
    await new Promise((r) => setTimeout(r, 100));
    expect((await JobModel.findById(job._id).lean())?.lastHeartbeat).toBeNull();
  });

  test('a job that THROWS still clears its interval, fails cleanly, and releases the course', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    const job = await makeJob({ userId: user._id, courseId: course._id, type: 'clarify' });
    await CourseModel.updateOne({ _id: course._id }, { $set: { activeJobId: job._id, activeLesson: { moduleIndex: 1, lessonIndex: 2 } } });

    clarifyMock.mockRejectedValueOnce(new Error('agent exploded'));

    await processJob(job._id.toString());

    const failed = await JobModel.findById(job._id).lean();
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('agent exploded');
    expect(failed?.lastHeartbeat).toBeNull();

    // The lockout must be released on the failure path too, or the course is
    // stuck exactly as if the worker had died.
    const courseAfter = await CourseModel.findById(course._id).lean();
    expect(courseAfter?.activeJobId).toBeNull();
    expect(courseAfter?.activeLesson).toBeNull();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 10);
    await new Promise((r) => setTimeout(r, 100));
    expect((await JobModel.findById(job._id).lean())?.lastHeartbeat).toBeNull();
  });

  test('a failed job does not debit; a successful one does (the finally block is not the debit path)', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });

    const bad = await makeJob({ userId: user._id, courseId: course._id, type: 'clarify' });
    clarifyMock.mockRejectedValueOnce(new Error('nope'));
    await processJob(bad._id.toString());
    expect(debitMock).not.toHaveBeenCalled();

    const good = await makeJob({ userId: user._id, courseId: course._id, type: 'clarify' });
    await processJob(good._id.toString());
    expect(debitMock).toHaveBeenCalledTimes(1);
  });

  test('a vanished job row is a no-op, not a crash (processJob:vanished)', async () => {
    const { Types } = await import('mongoose');
    await expect(processJob(new Types.ObjectId().toString())).resolves.toBeUndefined();
  });
});
