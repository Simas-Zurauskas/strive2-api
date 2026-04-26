/**
 * Tests for the lesson-progress state machine. The forward-only invariant
 * (`completed → in_progress` is rejected) and the once-per-promotion
 * gamification fire are the load-bearing properties — bugs here corrupt
 * learning state or inflate XP.
 *
 * Strategy:
 *   - Real in-memory Mongo for UserLessonProgressModel writes
 *   - Mock @services/gamificationService so we can spy on side-effect calls
 *
 * Run: yarn test progressService
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse } from '../../test-helpers/factories';
import UserLessonProgressModel from '@models/UserLessonProgressModel';

vi.mock('@services/gamificationService', () => ({
  onLessonComplete: vi.fn(() => Promise.resolve()),
  onExercisePass: vi.fn(() => Promise.resolve()),
  recordActivity: vi.fn(() => Promise.resolve()),
  onQuizComplete: vi.fn(() => Promise.resolve()),
}));

import { upsertLessonProgress } from '@services/progressService';
import * as gamificationService from '@services/gamificationService';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
});

const ids = async () => {
  const user = await makeUser();
  const course = await makeCourse({ userId: user._id });
  return {
    userId: user._id.toString(),
    courseId: course._id.toString(),
  };
};

// ── Forward-only state machine ─────────────────────────

describe('upsertLessonProgress — forward-only state machine', () => {
  test('not_started → in_progress: status set, gamification does NOT fire onLessonComplete', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({
      userId,
      courseId,
      moduleIndex: 0,
      lessonIndex: 0,
      status: 'in_progress',
    });

    const row = await UserLessonProgressModel.findOne({ userId, courseId, moduleIndex: 0, lessonIndex: 0 }).lean();
    expect(row?.status).toBe('in_progress');
    expect(gamificationService.onLessonComplete).not.toHaveBeenCalled();
  });

  test('in_progress → completed: status promoted, completedAt set, gamification fires once', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'in_progress' });
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'completed' });

    const row = await UserLessonProgressModel.findOne({ userId, courseId, moduleIndex: 0, lessonIndex: 0 }).lean();
    expect(row?.status).toBe('completed');
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(gamificationService.onLessonComplete).toHaveBeenCalledOnce();
  });

  // ⚠️ BUG (revealed by tests 2026-04-24):
  // When a learner completes a lesson WITHOUT first marking it in_progress
  // (i.e. the row is created fresh via $setOnInsert with status='completed'),
  // gamification.onLessonComplete is NEVER fired. The post-upsert conditional
  // updateOne filters on `status: { $in: [not_started, in_progress] }` —
  // but the doc was just created with status='completed', so no row matches,
  // modifiedCount=0, and the side-effect path is skipped. Tests below capture
  // this actual behavior; the audit lists it for follow-up.
  test('completed-on-fresh-row: status set but gamification does NOT fire (BUG)', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'completed' });

    const row = await UserLessonProgressModel.findOne({ userId, courseId, moduleIndex: 0, lessonIndex: 0 }).lean();
    expect(row?.status).toBe('completed');
    expect(row?.completedAt).toBeFalsy(); // also a side-effect of the same bug
    expect(gamificationService.onLessonComplete).not.toHaveBeenCalled(); // BUG
  });

  test('completed → in_progress: REJECTED — status stays completed', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'completed' });
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'in_progress' });

    const row = await UserLessonProgressModel.findOne({ userId, courseId, moduleIndex: 0, lessonIndex: 0 }).lean();
    expect(row?.status).toBe('completed'); // forward-only invariant holds
  });

  test('completed → completed (idempotent): no gamification fire either time (see BUG above)', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'completed' });
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'completed' });
    expect(gamificationService.onLessonComplete).not.toHaveBeenCalled();
  });
});

// ── Concurrent completion races ────────────────────────

describe('upsertLessonProgress — concurrent races', () => {
  test('two simultaneous completion calls (after in_progress baseline): only one wins, gamification fires once', async () => {
    const { userId, courseId } = await ids();
    // Pre-seed in_progress so the conditional updateOne has a row to promote
    // — see the BUG note above for why fresh-row completes don't fire.
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'in_progress' });
    vi.clearAllMocks();

    await Promise.all([
      upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'completed' }),
      upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'completed' }),
    ]);

    const row = await UserLessonProgressModel.findOne({ userId, courseId, moduleIndex: 0, lessonIndex: 0 }).lean();
    expect(row?.status).toBe('completed');
    // Critical invariant: gamification fires exactly once even under race.
    expect(gamificationService.onLessonComplete).toHaveBeenCalledOnce();
  });
});

// ── Bookmarks + notes preserve other fields ─────────────

describe('upsertLessonProgress — partial updates preserve other fields', () => {
  test('bookmark toggle on a completed lesson: status preserved', async () => {
    const { userId, courseId } = await ids();
    // Take the in_progress → completed path so gamification correctly fires once.
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'in_progress' });
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'completed' });
    expect(gamificationService.onLessonComplete).toHaveBeenCalledOnce();

    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, bookmarked: true });

    const row = await UserLessonProgressModel.findOne({ userId, courseId, moduleIndex: 0, lessonIndex: 0 }).lean();
    expect(row?.status).toBe('completed');
    expect(row?.bookmarked).toBe(true);
    expect(gamificationService.onLessonComplete).toHaveBeenCalledOnce(); // still 1
  });

  test('notes update preserves status', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'in_progress' });
    await upsertLessonProgress({
      userId,
      courseId,
      moduleIndex: 0,
      lessonIndex: 0,
      notes: 'I should remember this',
    });

    const row = await UserLessonProgressModel.findOne({ userId, courseId, moduleIndex: 0, lessonIndex: 0 }).lean();
    expect(row?.status).toBe('in_progress');
    expect(row?.notes).toBe('I should remember this');
  });

  test('timeSpentDelta accumulates, never resets', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, timeSpentDelta: 30 });
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, timeSpentDelta: 45 });

    const row = await UserLessonProgressModel.findOne({ userId, courseId, moduleIndex: 0, lessonIndex: 0 }).lean();
    expect(row?.timeSpentSeconds).toBe(75);
  });

  test('timeSpentDelta of 0 or negative is ignored', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, timeSpentDelta: 30 });
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, timeSpentDelta: 0 });
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, timeSpentDelta: -5 });

    const row = await UserLessonProgressModel.findOne({ userId, courseId, moduleIndex: 0, lessonIndex: 0 }).lean();
    expect(row?.timeSpentSeconds).toBe(30); // only the +30 counts
  });
});

// ── Side-effect gating ─────────────────────────────────

describe('upsertLessonProgress — side-effect gating', () => {
  test('exerciseAttempt with passed=true fires onExercisePass', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({
      userId,
      courseId,
      moduleIndex: 0,
      lessonIndex: 0,
      exerciseAttempt: { blockId: 'b1', code: 'x = 1', passed: true },
    });
    expect(gamificationService.onExercisePass).toHaveBeenCalledOnce();
  });

  test('exerciseAttempt with passed=false does NOT fire onExercisePass', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({
      userId,
      courseId,
      moduleIndex: 0,
      lessonIndex: 0,
      exerciseAttempt: { blockId: 'b1', code: 'x = 1', passed: false },
    });
    expect(gamificationService.onExercisePass).not.toHaveBeenCalled();
  });

  test('completion (via in_progress → completed) fires onLessonComplete; recordActivity NOT also called', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'in_progress' });
    vi.clearAllMocks(); // reset so we only count the completion event
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'completed' });
    expect(gamificationService.onLessonComplete).toHaveBeenCalledOnce();
    // Source comments: "Lesson completion already records activity via
    // onLessonComplete, so skip if that fired" — i.e. completionFired
    // short-circuits the recordActivity branch.
    expect(gamificationService.recordActivity).not.toHaveBeenCalled();
  });

  test('non-completion meaningful interaction (in_progress) records activity', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, status: 'in_progress' });
    expect(gamificationService.recordActivity).toHaveBeenCalledOnce();
  });

  test('quizResponse alone (no status, no completion) records activity', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({
      userId,
      courseId,
      moduleIndex: 0,
      lessonIndex: 0,
      quizResponse: { blockId: 'q1', selectedOption: 0, correct: true },
    });
    expect(gamificationService.recordActivity).toHaveBeenCalledOnce();
  });

  test('bookmark-only update is NOT a meaningful interaction (no recordActivity)', async () => {
    const { userId, courseId } = await ids();
    await upsertLessonProgress({ userId, courseId, moduleIndex: 0, lessonIndex: 0, bookmarked: true });
    expect(gamificationService.recordActivity).not.toHaveBeenCalled();
  });
});
