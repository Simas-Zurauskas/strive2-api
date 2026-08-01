/**
 * The stuck-job watchdog, end to end against real Mongo.
 *
 * The production bug this file exists to prevent is a **permanently locked
 * course**. `submitJob` claims `course.activeJobId` atomically and refuses a
 * second job while it is set. If the worker dies in a way that bypasses
 * `processJob`'s `finally` — a fatal escaping the timeout race, an OOM that
 * does not kill the process, a container replaced mid-job — the Job row stays
 * `processing` and `activeJobId` stays claimed *forever*. The user sees
 * "already running" on every retry, for that course, permanently. The only
 * remedy without this watchdog is a manual DB write.
 *
 * `sweepStuckJobs`, `startStuckJobWatchdog` and `stopStuckJobWatchdog` had
 * ZERO references in any test file before PLAN Phase 8.
 *
 * The mirror bug is just as bad and is asserted too: a watchdog that reaps
 * too eagerly kills a HEALTHY in-flight generation (the user loses 60-120s of
 * work and the credits already spent), or clears a *successor's* freshly
 * claimed `activeJobId` and lets two jobs run on one course at once.
 *
 * ── How the private sweep is reached ──────────────────────────────────────
 * `sweepStuckJobs` is module-private; only start/stop are exported. This file
 * uses `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` and
 * drives the real `startStuckJobWatchdog()`. Faking ONLY the interval
 * functions is deliberate — a blanket `vi.useFakeTimers()` freezes
 * `setTimeout`, which the MongoDB driver uses for server selection and
 * heartbeats, and every DB call in the file then hangs to the 30s timeout.
 * No production change was needed; `sweepStuckJobs` stays unexported.
 *
 * Run: yarn test jobRunner.watchdog
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type mongoose from 'mongoose';

// `submitJob` schedules `processJob` through pLimit; no-op it so the final
// "the lockout is really released" test does not run a real generation.
vi.mock('p-limit', () => ({
  default: () => (_fn: unknown) => Promise.resolve(),
}));

import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, makeJob, CourseModel, JobModel } from '../../test-helpers/factories';
import { startStuckJobWatchdog, stopStuckJobWatchdog, submitJob } from '@services/jobRunner';
import { jobEvents } from '@services/jobEvents';

setupTestDb();

const STALE_MS = 120_000; // STALE_HEARTBEAT_MS in jobRunner.ts
const TICK_MS = 60_000; // WATCHDOG_INTERVAL_MS in jobRunner.ts

/**
 * Poll until `predicate` holds. The watchdog's interval callback is
 * fire-and-forget (`sweepStuckJobs().catch(...)`), so advancing fake timers
 * starts the sweep but cannot await it. `setTimeout` is deliberately NOT
 * faked, so this is a real wait.
 */
const waitFor = async (predicate: () => Promise<boolean>, label: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out: ${label}`);
};

/**
 * One watchdog tick, plus a wait for the sweep it kicked off.
 *
 * `retry` defaults to true: `sweepStuckJobs` swallows its own errors
 * (`bgError`), so a transient failure under a contended shared mongod would
 * otherwise turn into a hung wait. A second tick is what production would do
 * 60 seconds later anyway. The two tests that assert an EXACT per-tick count
 * pass `retry: false`, because for them "how much one tick does" is the
 * subject.
 */
const tick = async (
  settled: () => Promise<boolean>,
  label: string,
  { retry = true, settleMs = 8_000 }: { retry?: boolean; settleMs?: number } = {},
) => {
  await vi.advanceTimersByTimeAsync(TICK_MS);
  try {
    await waitFor(settled, label, settleMs);
    return;
  } catch (err) {
    if (!retry) throw err;
  }
  await vi.advanceTimersByTimeAsync(TICK_MS);
  await waitFor(settled, `${label} (after a second tick)`, settleMs);
};

const staleJob = async (params: {
  userId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  ageMs?: number;
  status?: 'processing' | 'pending';
}) => {
  const job = await makeJob({
    userId: params.userId,
    courseId: params.courseId,
    type: 'generate_lesson',
    status: params.status ?? 'processing',
  });
  await JobModel.updateOne(
    { _id: job._id },
    { $set: { lastHeartbeat: new Date(Date.now() - (params.ageMs ?? STALE_MS + 60_000)) } },
  );
  return job;
};

/**
 * Capture the terminal `jobEvents` payloads.
 *
 * These are also the settle signal every test below waits on, and that is
 * deliberate: `jobEvents.emit('update', …)` is the LAST statement of a sweep
 * iteration, AFTER the job row is failed and AFTER the course is unlocked.
 * Waiting on "the job row says failed" instead lets assertions about the
 * course race the rest of the same iteration — which is exactly how this file
 * flaked before the settle signal was moved here.
 */
const captureUpdates = () => {
  const updates: Record<string, unknown>[] = [];
  const listener = (payload: Record<string, unknown>) => updates.push(payload);
  jobEvents.on('update', listener);
  return {
    updates,
    stop: () => jobEvents.off('update', listener),
    /** Predicate: the sweep iteration for this job id has fully completed. */
    swept: (jobId: string) => async () => updates.some((u) => u.jobId === jobId),
    count: (n: number) => async () => updates.length === n,
  };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  // Registered after setupTestDb()'s afterEach, and vitest runs afterEach
  // hooks LIFO, so real timers are restored BEFORE the collection cleanup.
  stopStuckJobWatchdog();
  vi.useRealTimers();
});

describe('startStuckJobWatchdog — reaping', () => {
  test('a processing job with a stale heartbeat is failed, and its course is UNLOCKED so a new job can claim it', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const job = await staleJob({ userId: user._id, courseId: course._id });
    await CourseModel.updateOne({ _id: course._id }, { $set: { activeJobId: job._id, activeLesson: { moduleIndex: 0, lessonIndex: 0 } } });

    const { stop, swept } = captureUpdates();
    startStuckJobWatchdog();
    await tick(swept(job._id.toString()), 'job swept');
    stop();

    const after = await JobModel.findById(job._id).lean();
    expect(after?.status).toBe('failed');
    expect(after?.error).toBe('Stuck job (no heartbeat)');
    expect(after?.completedAt).toBeInstanceOf(Date);
    expect(after?.lastHeartbeat).toBeNull();

    // The user-visible half: the course mutex is released.
    const courseAfter = await CourseModel.findById(course._id).lean();
    expect(courseAfter?.activeJobId).toBeNull();
    expect(courseAfter?.activeLesson).toBeNull();
  });

  test('a processing job with a FRESH heartbeat is left completely alone — a working job must never be reaped', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const healthy = await staleJob({ userId: user._id, courseId: course._id, ageMs: 30_000 });
    const stale = await staleJob({ userId: user._id, courseId: course._id });
    await CourseModel.updateOne({ _id: course._id }, { $set: { activeJobId: healthy._id } });

    const { stop, swept } = captureUpdates();
    startStuckJobWatchdog();
    await tick(swept(stale._id.toString()), 'stale job swept');
    stop();

    expect((await JobModel.findById(healthy._id).lean())?.status).toBe('processing');
    // …and the healthy job's claim on the course survives, because the
    // course update is conditional on `activeJobId` matching the SWEPT job.
    expect((await CourseModel.findById(course._id).lean())?.activeJobId?.toString()).toBe(healthy._id.toString());
  });

  test('a PENDING job with an old heartbeat is not swept — only `processing` rows are reaped', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const pending = await staleJob({ userId: user._id, courseId: course._id, status: 'pending' });
    const processing = await staleJob({ userId: user._id, courseId: course._id });

    const { stop, swept } = captureUpdates();
    startStuckJobWatchdog();
    await tick(swept(processing._id.toString()), 'processing job swept');
    stop();

    expect((await JobModel.findById(pending._id).lean())?.status).toBe('pending');
  });

  test('a successor that already claimed the course keeps its claim — the sweep never steals activeJobId', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const dead = await staleJob({ userId: user._id, courseId: course._id });
    const successor = await makeJob({ userId: user._id, courseId: course._id, type: 'generate_lesson', status: 'pending' });
    // The race the conditional filter `{ _id, activeJobId: job._id }` exists
    // for: the course now points at the SUCCESSOR, not at the dead job.
    await CourseModel.updateOne({ _id: course._id }, { $set: { activeJobId: successor._id } });

    const { stop, swept } = captureUpdates();
    startStuckJobWatchdog();
    await tick(swept(dead._id.toString()), 'dead job swept');
    stop();

    expect((await CourseModel.findById(course._id).lean())?.activeJobId?.toString()).toBe(successor._id.toString());
    expect((await JobModel.findById(successor._id).lean())?.status).toBe('pending');
  });

  test('the sweep is bounded at 20 jobs per tick; the remainder is picked up on the next tick', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    for (let i = 0; i < 25; i++) await staleJob({ userId: user._id, courseId: course._id });

    const { stop, count } = captureUpdates();
    startStuckJobWatchdog();
    await tick(count(20), 'first tick swept exactly 20', { retry: false, settleMs: 20_000 });
    expect(await JobModel.countDocuments({ status: 'failed' })).toBe(20);
    expect(await JobModel.countDocuments({ status: 'processing' })).toBe(5);

    await tick(count(25), 'second tick swept the rest', { retry: false, settleMs: 20_000 });
    expect(await JobModel.countDocuments({ status: 'processing' })).toBe(0);
    stop();
  });

  test('every swept job emits a `failed` jobEvents payload the client can act on', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const a = await staleJob({ userId: user._id, courseId: course._id });
    const b = await staleJob({ userId: user._id, courseId: course._id });

    const { updates, stop, count } = captureUpdates();
    startStuckJobWatchdog();
    await tick(count(2), 'both swept and both emitted');
    stop();

    const jobIds = updates.map((u) => u.jobId);
    expect(jobIds).toContain(a._id.toString());
    expect(jobIds).toContain(b._id.toString());
    expect(updates[0]).toMatchObject({
      status: 'failed',
      error: 'Stuck job (no heartbeat)',
      courseId: course._id.toString(),
      type: 'generate_lesson',
      userId: user._id.toString(),
    });
  });

  test('nothing to sweep: a clean database produces no writes and no events', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const healthy = await staleJob({ userId: user._id, courseId: course._id, ageMs: 1_000 });

    const { updates, stop } = captureUpdates();
    startStuckJobWatchdog();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    // A negative assertion with no event to wait on: the sweep is one query,
    // so 500ms is generous. The failure mode of too short a wait here is a
    // false PASS, not a flake — which is why the positive direction is
    // covered by the tests above rather than by this one.
    await new Promise((r) => setTimeout(r, 500));
    stop();

    expect(updates).toEqual([]);
    expect((await JobModel.findById(healthy._id).lean())?.status).toBe('processing');
  });
});

describe('startStuckJobWatchdog — the lockout is really released', () => {
  test('submitJob succeeds on a course whose stuck job was swept (the whole point of the watchdog)', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const dead = await staleJob({ userId: user._id, courseId: course._id });
    await CourseModel.updateOne({ _id: course._id }, { $set: { activeJobId: dead._id } });

    // Before the sweep the course is locked: this is the user's experience
    // for as long as the stale row survives.
    await expect(
      submitJob({ userId: user._id.toString(), courseId: course._id.toString(), type: 'generate_lesson' }),
    ).rejects.toThrow(/already running/);

    const { stop, swept } = captureUpdates();
    startStuckJobWatchdog();
    await tick(swept(dead._id.toString()), 'dead job swept and course unlocked');
    stop();

    const newJobId = await submitJob({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      type: 'generate_lesson',
    });
    expect(newJobId).toBeTruthy();
    expect((await CourseModel.findById(course._id).lean())?.activeJobId?.toString()).toBe(newJobId);
  });
});

describe('start/stop lifecycle', () => {
  test('startStuckJobWatchdog is idempotent — a second call does not install a second timer', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    for (let i = 0; i < 25; i++) await staleJob({ userId: user._id, courseId: course._id });

    const { stop, count } = captureUpdates();
    startStuckJobWatchdog();
    startStuckJobWatchdog(); // must be a no-op

    // If two timers were installed, one tick would run TWO sweeps and take
    // the count past the 20-per-tick bound.
    await tick(count(20), 'one sweep ran', { retry: false, settleMs: 20_000 });
    await new Promise((r) => setTimeout(r, 500));
    stop();
    expect(await JobModel.countDocuments({ status: 'failed' })).toBe(20);
  });

  test('stopStuckJobWatchdog stops the sweeping — a stale job added afterwards survives', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    startStuckJobWatchdog();
    stopStuckJobWatchdog();

    const dead = await staleJob({ userId: user._id, courseId: course._id });
    await vi.advanceTimersByTimeAsync(TICK_MS * 5);
    await new Promise((r) => setTimeout(r, 200));

    expect((await JobModel.findById(dead._id).lean())?.status).toBe('processing');
  });

  test('stopStuckJobWatchdog is safe to call when nothing is running', () => {
    expect(() => stopStuckJobWatchdog()).not.toThrow();
    expect(() => stopStuckJobWatchdog()).not.toThrow();
  });
});
