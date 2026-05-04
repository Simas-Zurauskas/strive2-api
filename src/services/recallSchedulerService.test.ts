/**
 * Tests for the Leitner v0 scheduler:
 *   - applyRating: pure function — all 4 rating semantics + clamps
 *   - rateRecall: persistence + mastery race detection (justMastered)
 *   - skipRecall, setRecallMode: simple persistence
 *
 * Run: yarn test recallScheduler
 */

import assert from 'node:assert/strict';
import { describe, test, expect } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, makeLessonContent, makeRecallCard, makeRecallProgress, UserRecallProgressModel } from '../../test-helpers/factories';
import { LEITNER_BOX_INTERVAL_DAYS, LEITNER_MAX_BOX } from '@lib/recallConstants';
import {
  applyRating,
  rateRecall,
  skipRecall,
  setRecallMode,
  type SchedulerSnapshot,
} from '@services/recallSchedulerService';

setupTestDb();

const baseSnapshot = (overrides: Partial<SchedulerSnapshot> = {}): SchedulerSnapshot => ({
  box: 0,
  reps: 0,
  lapses: 0,
  state: 'new',
  lastReview: null,
  nextDue: new Date(),
  ...overrides,
});

const DAY_MS = 24 * 60 * 60 * 1000;

// ── applyRating (pure) ─────────────────────────────────

describe('applyRating — Leitner box transitions', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  test('rating 1 (Again): box→0, reps reset, lapses+=1, state=relearning', () => {
    const next = applyRating({ snapshot: baseSnapshot({ box: 3, reps: 5 }), rating: 1, now });
    expect(next.box).toBe(0);
    expect(next.reps).toBe(0);
    expect(next.lapses).toBe(1);
    expect(next.state).toBe('relearning');
    expect(next.nextDue.getTime() - now.getTime()).toBe(LEITNER_BOX_INTERVAL_DAYS[0] * DAY_MS);
  });

  test('rating 2 (Hard): box stays, reps+=1, state→learning when starting from new', () => {
    const next = applyRating({ snapshot: baseSnapshot({ box: 0, state: 'new' }), rating: 2, now });
    expect(next.box).toBe(0);
    expect(next.reps).toBe(1);
    expect(next.state).toBe('learning');
  });

  test('rating 2 (Hard) on existing review card → state=review (not relearning)', () => {
    const next = applyRating({ snapshot: baseSnapshot({ box: 2, state: 'review' }), rating: 2, now });
    expect(next.box).toBe(2);
    expect(next.state).toBe('review');
  });

  test('rating 3 (Good): box+=1 (capped at MAX), state=review', () => {
    const next = applyRating({ snapshot: baseSnapshot({ box: 1, reps: 2 }), rating: 3, now });
    expect(next.box).toBe(2);
    expect(next.reps).toBe(3);
    expect(next.state).toBe('review');
    expect(next.nextDue.getTime() - now.getTime()).toBe(LEITNER_BOX_INTERVAL_DAYS[2] * DAY_MS);
  });

  test('rating 3 at MAX_BOX: box stays clamped at MAX, state=review', () => {
    const next = applyRating({ snapshot: baseSnapshot({ box: LEITNER_MAX_BOX }), rating: 3, now });
    expect(next.box).toBe(LEITNER_MAX_BOX);
  });

  test('rating 4 (Easy): box+=2 (capped at MAX), reps+=1', () => {
    const next = applyRating({ snapshot: baseSnapshot({ box: 1 }), rating: 4, now });
    expect(next.box).toBe(3);
    expect(next.state).toBe('review');
  });

  test('rating 4 from MAX-1: clamped at MAX (no over-promotion)', () => {
    const next = applyRating({ snapshot: baseSnapshot({ box: LEITNER_MAX_BOX - 1 }), rating: 4, now });
    expect(next.box).toBe(LEITNER_MAX_BOX); // capped, not 5
  });

  test('rating 4 from MAX: stays at MAX', () => {
    const next = applyRating({ snapshot: baseSnapshot({ box: LEITNER_MAX_BOX }), rating: 4, now });
    expect(next.box).toBe(LEITNER_MAX_BOX);
  });
});

// ── rateRecall (persists + mastery race) ──────────────

describe('rateRecall', () => {
  const setupCard = async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const lesson = await makeLessonContent({ courseId: course._id });
    const card = await makeRecallCard({ courseId: course._id, lessonId: lesson._id });
    return { userId: user._id.toString(), recallCardId: card._id.toString() };
  };

  test('first rating creates a progress row, wasNew=true, justMastered=false', async () => {
    const { userId, recallCardId } = await setupCard();
    const result = await rateRecall({ userId, recallCardId, rating: 3 });
    expect(result.wasNew).toBe(true);
    expect(result.justMastered).toBe(false);
    expect(result.progress.box).toBe(1); // 0 → 0+1 = 1 with rating 3
    expect(result.progress.reps).toBe(1);

    const stored = await UserRecallProgressModel.countDocuments({ userId, recallCardId });
    expect(stored).toBe(1);
  });

  test('second rating updates the same row (no duplicate), wasNew=false', async () => {
    const { userId, recallCardId } = await setupCard();
    await rateRecall({ userId, recallCardId, rating: 3 });
    const result = await rateRecall({ userId, recallCardId, rating: 3 });
    expect(result.wasNew).toBe(false);
    expect(result.progress.box).toBe(2);

    const count = await UserRecallProgressModel.countDocuments({ userId, recallCardId });
    expect(count).toBe(1);
  });

  test('justMastered fires exactly once on first transition to MAX_BOX', async () => {
    const { userId, recallCardId } = await setupCard();
    // 0 → 2 → 4 with two Easy ratings
    const r1 = await rateRecall({ userId, recallCardId, rating: 4 });
    expect(r1.progress.box).toBe(2);
    expect(r1.justMastered).toBe(false);

    const r2 = await rateRecall({ userId, recallCardId, rating: 4 });
    expect(r2.progress.box).toBe(LEITNER_MAX_BOX);
    expect(r2.justMastered).toBe(true);
    expect(r2.progress.masteredAt).toBeInstanceOf(Date);
  });

  test('justMastered does NOT re-fire on re-mastery after regression', async () => {
    const { userId, recallCardId } = await setupCard();
    await rateRecall({ userId, recallCardId, rating: 4 }); // 0→2
    await rateRecall({ userId, recallCardId, rating: 4 }); // 2→4 (mastered)
    await rateRecall({ userId, recallCardId, rating: 1 }); // 4→0 (Again, lapse)
    const r4 = await rateRecall({ userId, recallCardId, rating: 4 }); // 0→2
    expect(r4.progress.box).toBe(2);
    expect(r4.justMastered).toBe(false);

    const r5 = await rateRecall({ userId, recallCardId, rating: 4 }); // 2→4
    expect(r5.progress.box).toBe(LEITNER_MAX_BOX);
    // Already mastered once — masteredAt was set on the first MAX transition
    // and is NEVER cleared, even after lapses. justMastered is the
    // "first-time" signal only.
    expect(r5.justMastered).toBe(false);
  });

  test('justMastered race: only one of two concurrent calls observes true', async () => {
    const { userId, recallCardId } = await setupCard();
    // Pre-position at box=3 so the next rating (3) lands at 4
    await makeRecallProgress({
      userId,
      recallCardId,
      box: 3,
      nextDue: new Date(),
      mode: 'tap-reveal',
    });

    const [a, b] = await Promise.all([
      rateRecall({ userId, recallCardId, rating: 3 }),
      rateRecall({ userId, recallCardId, rating: 3 }),
    ]);

    const masteredCount = [a, b].filter((r) => r.justMastered).length;
    expect(masteredCount).toBe(1); // exactly one wins
  });

  test('lapses counter accumulates across multiple Again ratings', async () => {
    const { userId, recallCardId } = await setupCard();
    await rateRecall({ userId, recallCardId, rating: 1 });
    await rateRecall({ userId, recallCardId, rating: 1 });
    const r3 = await rateRecall({ userId, recallCardId, rating: 1 });
    expect(r3.progress.lapses).toBe(3);
  });
});

// ── skipRecall ─────────────────────────────────────────

describe('skipRecall', () => {
  test('defers nextDue by RECALL_SKIP_DAYS, no box change', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const lesson = await makeLessonContent({ courseId: course._id });
    const card = await makeRecallCard({ courseId: course._id, lessonId: lesson._id });

    await makeRecallProgress({
      userId: user._id,
      recallCardId: card._id,
      box: 2,
      nextDue: new Date(),
    });
    const before = await UserRecallProgressModel.findOne({ userId: user._id, recallCardId: card._id }).lean();

    const after = await skipRecall({
      userId: user._id.toString(),
      recallCardId: card._id.toString(),
    });
    expect(after.box).toBe(2); // unchanged
    expect(after.nextDue.getTime()).toBeGreaterThan(before!.nextDue.getTime());
  });
});

// ── setRecallMode ──────────────────────────────────────

describe('setRecallMode', () => {
  test('persists tap-reveal vs typed-recall preference', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const lesson = await makeLessonContent({ courseId: course._id });
    const card = await makeRecallCard({ courseId: course._id, lessonId: lesson._id });

    const after = await setRecallMode({
      userId: user._id.toString(),
      recallCardId: card._id.toString(),
      mode: 'typed-recall',
    });
    expect(after.mode).toBe('typed-recall');
  });
});
