/**
 * Tests for the quiz attempt + spaced-review scheduling logic. Covers:
 *   - computeMasteryTier thresholds (80 / 60 / <60)
 *   - First-attempt scheduling (REVIEW_INITIAL_INTERVALS)
 *   - Tier-up doubles interval (capped at 90 days)
 *   - Tier-down halves interval (floored at 1 day)
 *   - needs_review forces interval=1 regardless of history
 *   - bestScore / bestTier retain historical peak across regressions
 *   - $slice -100 attempts cap (rolling window)
 *
 * Strategy:
 *   - Real in-memory Mongo for ModuleQuizContent + UserModuleQuizProgress
 *   - Mock @services/gamificationService — quiz tests focus on scheduling
 *
 * Run: yarn test quizProgressService
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse } from '../../test-helpers/factories';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';

vi.mock('@services/gamificationService', () => ({
  onQuizComplete: vi.fn(() => Promise.resolve()),
}));

import { computeMasteryTier, submitQuizAttempt } from '@services/quizProgressService';
import * as gamificationService from '@services/gamificationService';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
});

const seedQuiz = async (params: {
  courseId: string;
  moduleIndex?: number;
  questions?: Array<{ id: string; correctIndex: number }>;
}) => {
  const questions = (params.questions ?? [
    { id: 'q1', correctIndex: 0 },
    { id: 'q2', correctIndex: 1 },
  ]).map((q) => ({
    id: q.id,
    question: `Question ${q.id}`,
    options: ['A', 'B', 'C', 'D'],
    correctIndex: q.correctIndex,
    explanation: 'because',
    sourceLessons: [],
    isInterleaved: false,
  }));

  return ModuleQuizContentModel.create({
    courseId: params.courseId,
    moduleIndex: params.moduleIndex ?? 0,
    questions,
    version: 1,
  });
};

const ctx = async () => {
  const user = await makeUser();
  const course = await makeCourse({ userId: user._id });
  const quiz = await seedQuiz({ courseId: course._id.toString() });
  return {
    userId: user._id.toString(),
    courseId: course._id.toString(),
    quiz,
  };
};

// ── computeMasteryTier thresholds ──────────────────────

describe('computeMasteryTier', () => {
  test('score 100 → mastered', () => expect(computeMasteryTier(100)).toBe('mastered'));
  test('score 80 (boundary) → mastered', () => expect(computeMasteryTier(80)).toBe('mastered'));
  test('score 79 → passed', () => expect(computeMasteryTier(79)).toBe('passed'));
  test('score 60 (boundary) → passed', () => expect(computeMasteryTier(60)).toBe('passed'));
  test('score 59 → needs_review', () => expect(computeMasteryTier(59)).toBe('needs_review'));
  test('score 0 → needs_review', () => expect(computeMasteryTier(0)).toBe('needs_review'));
});

// ── submitQuizAttempt — first attempt scheduling ─────────

describe('submitQuizAttempt — first attempt scheduling', () => {
  test('first attempt mastered: nextReview = now + 7d, no consecutive successes', async () => {
    const { userId, courseId } = await ctx();
    const result = await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 }, // correct
        { questionId: 'q2', selectedOption: 1 }, // correct
      ],
    });

    expect(result.attempt.score).toBe(100);
    expect(result.attempt.masteryTier).toBe('mastered');
    expect(result.reviewIntervalDays).toBe(7);
    const row = await UserModuleQuizProgressModel.findOne({ userId, courseId, moduleIndex: 0 }).lean();
    expect(row?.consecutiveSuccesses).toBe(0);
    expect(row?.bestScore).toBe(100);
    expect(row?.bestTier).toBe('mastered');
  });

  test('first attempt passed (50% on 2 questions = 50 → needs_review). Use 1/2 = 50%, but boundary needs ≥60', async () => {
    // Use a 4-question quiz so 50% (2/4) is a clear "needs_review" case (<60)
    // and 75% (3/4) is "passed"
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await seedQuiz({
      courseId: course._id.toString(),
      questions: [
        { id: 'q1', correctIndex: 0 },
        { id: 'q2', correctIndex: 0 },
        { id: 'q3', correctIndex: 0 },
        { id: 'q4', correctIndex: 0 },
      ],
    });

    const result = await submitQuizAttempt({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 0 },
        { questionId: 'q3', selectedOption: 0 },
        { questionId: 'q4', selectedOption: 1 }, // wrong
      ],
    });
    expect(result.attempt.score).toBe(75);
    expect(result.attempt.masteryTier).toBe('passed');
    expect(result.reviewIntervalDays).toBe(3); // REVIEW_INITIAL_INTERVALS.passed
  });

  test('first attempt needs_review (0%): nextReview = now + 1d', async () => {
    const { userId, courseId } = await ctx();
    const result = await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 1 }, // wrong
        { questionId: 'q2', selectedOption: 0 }, // wrong
      ],
    });
    expect(result.attempt.score).toBe(0);
    expect(result.reviewIntervalDays).toBe(1);
  });

  test('throws when the response count != question count', async () => {
    const { userId, courseId } = await ctx();
    await expect(
      submitQuizAttempt({
        userId,
        courseId,
        moduleIndex: 0,
        responses: [{ questionId: 'q1', selectedOption: 0 }], // missing q2
      }),
    ).rejects.toThrow('Expected 2 responses');
  });

  test('throws when quiz content is missing', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    // No quiz content seeded
    await expect(
      submitQuizAttempt({
        userId: user._id.toString(),
        courseId: course._id.toString(),
        moduleIndex: 5,
        responses: [],
      }),
    ).rejects.toThrow('Quiz content not found');
  });
});

// ── submitQuizAttempt — spaced-review interval evolution ─

describe('submitQuizAttempt — interval evolution', () => {
  test('two consecutive masters: interval doubles 7 → 14, consecutiveSuccesses += 1', async () => {
    const { userId, courseId } = await ctx();
    // First mastered attempt → 7d, consecutive 0
    await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    });
    // Second mastered → doubled to 14d, consecutive 1
    const result = await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    });
    expect(result.reviewIntervalDays).toBe(14);
    const row = await UserModuleQuizProgressModel.findOne({ userId, courseId, moduleIndex: 0 }).lean();
    expect(row?.consecutiveSuccesses).toBe(1);
  });

  test('regression mastered → needs_review: interval resets to 1, consecutive resets to 0, bestTier RETAINS mastered', async () => {
    const { userId, courseId } = await ctx();
    await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    }); // mastered → 7d
    await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    }); // mastered again → 14d

    const result = await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 1 }, // wrong
        { questionId: 'q2', selectedOption: 0 }, // wrong
      ],
    }); // needs_review → 1d
    expect(result.attempt.masteryTier).toBe('needs_review');
    expect(result.reviewIntervalDays).toBe(1);

    const row = await UserModuleQuizProgressModel.findOne({ userId, courseId, moduleIndex: 0 }).lean();
    expect(row?.consecutiveSuccesses).toBe(0);
    expect(row?.bestScore).toBe(100); // historical peak retained
    expect(row?.bestTier).toBe('mastered'); // historical peak retained
  });

  test('regression mastered → passed (not needs_review): interval halves, not resets', async () => {
    const { userId, courseId } = await ctx();
    // Get to mastered with interval 14d (two consecutive masters)
    await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    });
    await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    });
    // Now drop to passed (50% on 2 questions wouldn't be passed; need a
    // bigger quiz). Use the seeded one, get only 1 right out of 2 = 50% =
    // needs_review, not passed. Re-seed a 5-question quiz so 60% = passed
    // is achievable.
    await ModuleQuizContentModel.deleteMany({ courseId });
    await seedQuiz({
      courseId,
      questions: [
        { id: 'q1', correctIndex: 0 },
        { id: 'q2', correctIndex: 0 },
        { id: 'q3', correctIndex: 0 },
        { id: 'q4', correctIndex: 0 },
        { id: 'q5', correctIndex: 0 },
      ],
    });

    const result = await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 0 },
        { questionId: 'q3', selectedOption: 0 },
        { questionId: 'q4', selectedOption: 1 }, // wrong
        { questionId: 'q5', selectedOption: 1 }, // wrong
      ],
    });
    expect(result.attempt.score).toBe(60);
    expect(result.attempt.masteryTier).toBe('passed');
    expect(result.reviewIntervalDays).toBe(7); // 14 / 2 = 7

    const row = await UserModuleQuizProgressModel.findOne({ userId, courseId, moduleIndex: 0 }).lean();
    expect(row?.consecutiveSuccesses).toBe(0);
  });

  test('interval cap at 90 days: many consecutive masters cannot push beyond REVIEW_MAX_INTERVAL_DAYS', async () => {
    const { userId, courseId } = await ctx();
    // Force a high reviewIntervalDays in DB to simulate a long history
    await UserModuleQuizProgressModel.create({
      userId,
      courseId,
      moduleIndex: 0,
      attempts: [
        {
          attemptNumber: 1,
          responses: [],
          score: 100,
          masteryTier: 'mastered',
          completedAt: new Date(),
          quizVersion: 1,
        },
      ],
      bestScore: 100,
      bestTier: 'mastered',
      reviewIntervalDays: 80, // close to cap
      consecutiveSuccesses: 5,
      nextReviewAt: new Date(),
    });

    const result = await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    });
    expect(result.attempt.masteryTier).toBe('mastered');
    expect(result.reviewIntervalDays).toBe(90); // 80 * 2 = 160 → clamped to 90
  });

  test('needs_review on subsequent attempt resets interval to 1d regardless of history', async () => {
    const { userId, courseId } = await ctx();
    await UserModuleQuizProgressModel.create({
      userId,
      courseId,
      moduleIndex: 0,
      attempts: [
        {
          attemptNumber: 1,
          responses: [],
          score: 100,
          masteryTier: 'mastered',
          completedAt: new Date(),
          quizVersion: 1,
        },
      ],
      bestScore: 100,
      bestTier: 'mastered',
      reviewIntervalDays: 30, // long history
      consecutiveSuccesses: 4,
      nextReviewAt: new Date(),
    });

    const result = await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 1 },
        { questionId: 'q2', selectedOption: 0 },
      ],
    });
    expect(result.attempt.masteryTier).toBe('needs_review');
    expect(result.reviewIntervalDays).toBe(1); // hard reset
  });
});

// ── $slice -100 attempts cap ─────────────────────────────

describe('submitQuizAttempt — attempts array cap', () => {
  test('101 attempts: rolling window keeps the last 100, but bestScore retains overall peak', async () => {
    const { userId, courseId } = await ctx();
    // Pre-load 99 attempts with score 60 (passed) so the next one fits naturally
    await UserModuleQuizProgressModel.create({
      userId,
      courseId,
      moduleIndex: 0,
      attempts: Array.from({ length: 99 }, (_, i) => ({
        attemptNumber: i + 1,
        responses: [],
        score: 60,
        masteryTier: 'passed' as const,
        completedAt: new Date(),
        quizVersion: 1,
      })),
      bestScore: 100, // peak from a never-stored attempt
      bestTier: 'mastered' as const,
      reviewIntervalDays: 7,
      consecutiveSuccesses: 0,
      nextReviewAt: new Date(),
    });

    // Submit two more attempts to trigger the rolling cap
    await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    });
    await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    });

    const row = await UserModuleQuizProgressModel.findOne({ userId, courseId, moduleIndex: 0 }).lean();
    expect(row?.attempts).toHaveLength(100); // capped
    expect(row?.bestScore).toBe(100); // historical peak retained even after rolling
    expect(row?.bestTier).toBe('mastered');
  });
});

// ── Side effects ─────────────────────────────────────────

describe('submitQuizAttempt — gamification side-effects', () => {
  test('first attempt: onQuizComplete fires with isReview=false', async () => {
    const { userId, courseId } = await ctx();
    await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    });
    expect(gamificationService.onQuizComplete).toHaveBeenCalledOnce();
    const call = vi.mocked(gamificationService.onQuizComplete).mock.calls[0][0];
    expect(call.isReview).toBe(false);
    expect(call.score).toBe(100);
    expect(call.previousBestScore).toBe(0);
  });

  test('second attempt: onQuizComplete fires with isReview=true', async () => {
    const { userId, courseId } = await ctx();
    await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 0 },
        { questionId: 'q2', selectedOption: 1 },
      ],
    });
    vi.clearAllMocks();
    await submitQuizAttempt({
      userId,
      courseId,
      moduleIndex: 0,
      responses: [
        { questionId: 'q1', selectedOption: 1 },
        { questionId: 'q2', selectedOption: 0 },
      ],
    });
    expect(gamificationService.onQuizComplete).toHaveBeenCalledOnce();
    const call = vi.mocked(gamificationService.onQuizComplete).mock.calls[0][0];
    expect(call.isReview).toBe(true);
    expect(call.previousBestScore).toBe(100);
  });
});
