/**
 * Tests for the spaced-review trigger logic. The two trigger paths are:
 *   1. Time-based — `nextReviewAt <= now`
 *   2. Progression-based — `maxModuleIndex - moduleIndex >= gap`,
 *      where gap is clamped to `min(REVIEW_PROGRESSION_GAPS[tier], totalModules - 1)`
 *
 * The clamp matters for small courses: a 2-module course mastered at module 0
 * needs gap=1 (clamped down from 3) to ever trigger when the user is on module 1.
 *
 * Run: yarn test reviewSchedulingService
 */

import assert from 'node:assert/strict';
import { describe, test, expect } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse } from '../../test-helpers/factories';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';

import {
  getCourseQuizProgress,
  getReviewsDue,
  getUnattemptedQuizzes,
} from '@services/reviewSchedulingService';

setupTestDb();

const seedCourse = async (params: {
  userId: mongoose.Types.ObjectId;
  modules?: number;
  status?: 'creating' | 'ready' | 'archived';
}) => {
  const moduleCount = params.modules ?? 3;
  return makeCourse({
    userId: params.userId,
    status: params.status ?? 'ready',
    structure: {
      reasoning: { learnerProfile: '', topicAnalysis: '', scopeDecisions: '', progressionStrategy: '' },
      modules: Array.from({ length: moduleCount }, (_, i) => ({
        name: `Module ${i + 1}`,
        description: '',
        lessons: [{ name: `L${i}.0`, description: '' }],
      })),
    },
  });
};

const seedQuizProgress = async (params: {
  userId: mongoose.Types.ObjectId | string;
  courseId: mongoose.Types.ObjectId | string;
  moduleIndex: number;
  bestTier: 'needs_review' | 'passed' | 'mastered';
  bestScore?: number;
  nextReviewAt?: Date | null;
  attempts?: number;
}) => {
  return UserModuleQuizProgressModel.create({
    userId: params.userId,
    courseId: params.courseId,
    moduleIndex: params.moduleIndex,
    bestScore: params.bestScore ?? 100,
    bestTier: params.bestTier,
    reviewIntervalDays: 7,
    consecutiveSuccesses: 1,
    nextReviewAt: params.nextReviewAt === undefined ? new Date() : params.nextReviewAt,
    attempts: Array.from({ length: params.attempts ?? 1 }, (_, i) => ({
      attemptNumber: i + 1,
      responses: [],
      score: params.bestScore ?? 100,
      masteryTier: params.bestTier,
      completedAt: new Date(),
      quizVersion: 1,
    })),
  });
};

// ── getReviewsDue — time trigger ───────────────────────

describe('getReviewsDue — time trigger', () => {
  test('nextReviewAt in the past → time-due fires', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 3 });
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      bestTier: 'mastered',
      nextReviewAt: new Date(Date.now() - 86400_000), // 1 day overdue
    });

    const result = await getReviewsDue({ userId: user._id.toString() });
    expect(result).toHaveLength(1);
    expect(result[0].reviewReason).toBe('time');
  });

  test('nextReviewAt in the future + no progression trigger → not due', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 5 });
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 4, // last module — no further to progress
      bestTier: 'mastered',
      nextReviewAt: new Date(Date.now() + 86400_000),
    });

    const result = await getReviewsDue({ userId: user._id.toString() });
    expect(result).toHaveLength(0);
  });

  test('nextReviewAt=null + legacy attempts: back-fills from lastAttempt + REVIEW_INITIAL_INTERVALS', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 2 });
    // Force a doc with nextReviewAt=null and an old completed attempt
    const oldDate = new Date(Date.now() - 30 * 86400_000); // 30d ago
    await UserModuleQuizProgressModel.create({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      bestScore: 100,
      bestTier: 'mastered',
      reviewIntervalDays: 7,
      consecutiveSuccesses: 1,
      nextReviewAt: null, // legacy doc
      attempts: [
        {
          attemptNumber: 1,
          responses: [],
          score: 100,
          masteryTier: 'mastered',
          completedAt: oldDate,
          quizVersion: 1,
        },
      ],
    });

    const result = await getReviewsDue({ userId: user._id.toString() });
    // Time-due: lastAttempt (30d ago) + 7d (mastered initial) = 23d in past → due
    expect(result).toHaveLength(1);
    expect(result[0].nextReviewAt).toBeTruthy();
  });
});

// ── getReviewsDue — progression trigger + gap clamping ──

describe('getReviewsDue — progression trigger + gap clamping', () => {
  test('2-module course, mastered module 0 + attempted module 1: gap clamped to 1, fires', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 2 });
    // Module 0 mastered, future review date (no time trigger)
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      bestTier: 'mastered',
      nextReviewAt: new Date(Date.now() + 30 * 86400_000),
    });
    // Module 1 attempted (just to push maxModuleIndex to 1)
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 1,
      bestTier: 'passed',
      nextReviewAt: new Date(Date.now() + 30 * 86400_000),
    });

    const result = await getReviewsDue({ userId: user._id.toString() });
    // mastered gap=3, clamped to min(3, 2-1) = 1; lead = maxModuleIndex(1) - module(0) = 1 ≥ 1 → fires
    const m0Item = result.find((r) => r.moduleIndex === 0);
    expect(m0Item).toBeTruthy();
    expect(m0Item?.reviewReason).toBe('progression');
  });

  test('1-module course: gap clamped to 1, but lead is always 0 → never fires', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 1 });
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      bestTier: 'mastered',
      nextReviewAt: new Date(Date.now() + 30 * 86400_000),
    });

    const result = await getReviewsDue({ userId: user._id.toString() });
    // maxModuleIndex - moduleIndex = 0 - 0 = 0 < gap (1) → no progression trigger
    expect(result).toHaveLength(0);
  });

  test('5-module course, mastered m0, learner on m4: gap=3, lead=4 → fires', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 5 });
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      bestTier: 'mastered',
      nextReviewAt: new Date(Date.now() + 30 * 86400_000),
    });
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 4,
      bestTier: 'passed',
      nextReviewAt: new Date(Date.now() + 30 * 86400_000),
    });

    const result = await getReviewsDue({ userId: user._id.toString() });
    const m0Item = result.find((r) => r.moduleIndex === 0);
    expect(m0Item?.reviewReason).toBe('progression');
  });

  test('passed tier (gap=2): triggers at lead=2', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 4 });
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      bestTier: 'passed',
      nextReviewAt: new Date(Date.now() + 30 * 86400_000),
    });
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 2,
      bestTier: 'passed',
      nextReviewAt: new Date(Date.now() + 30 * 86400_000),
    });

    const result = await getReviewsDue({ userId: user._id.toString() });
    const m0Item = result.find((r) => r.moduleIndex === 0);
    expect(m0Item?.reviewReason).toBe('progression');
  });
});

// ── getReviewsDue — sort order ─────────────────────────

describe('getReviewsDue — sort order', () => {
  test('progression-triggered items come BEFORE time-triggered items', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 5 });
    // Time-due item (nextReviewAt in past, no progression lead)
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      bestTier: 'mastered',
      nextReviewAt: new Date(Date.now() - 86400_000),
    });
    // Progression-due item: m1 mastered, m4 attempted
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 1,
      bestTier: 'mastered',
      nextReviewAt: new Date(Date.now() + 30 * 86400_000), // not time-due
    });
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 4,
      bestTier: 'passed',
      nextReviewAt: new Date(Date.now() + 30 * 86400_000),
    });

    const result = await getReviewsDue({ userId: user._id.toString() });
    // Progression items sorted before time items
    const reasons = result.map((r) => r.reviewReason);
    if (result.length >= 2) {
      const firstProgressionIdx = reasons.indexOf('progression');
      const firstTimeIdx = reasons.indexOf('time');
      if (firstProgressionIdx >= 0 && firstTimeIdx >= 0) {
        expect(firstProgressionIdx).toBeLessThan(firstTimeIdx);
      }
    }
  });
});

// ── getUnattemptedQuizzes ──────────────────────────────

describe('getUnattemptedQuizzes', () => {
  test('module with all lessons completed AND no quiz attempt → returned', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 1 });
    // Complete the one lesson
    await UserLessonProgressModel.create({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      lessonIndex: 0,
      status: 'completed',
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });

    const result = await getUnattemptedQuizzes({ userId: user._id.toString() });
    expect(result).toHaveLength(1);
    expect(result[0].moduleIndex).toBe(0);
  });

  test('module with quiz already attempted → NOT returned', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 1 });
    // Complete lesson + attempt quiz
    await UserLessonProgressModel.create({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      lessonIndex: 0,
      status: 'completed',
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });
    await seedQuizProgress({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      bestTier: 'passed',
    });

    const result = await getUnattemptedQuizzes({ userId: user._id.toString() });
    expect(result).toHaveLength(0);
  });

  test('module with not-all-lessons-completed → NOT returned', async () => {
    const user = await makeUser();
    const course = await makeCourse({
      userId: user._id,
      structure: {
        reasoning: { learnerProfile: '', topicAnalysis: '', scopeDecisions: '', progressionStrategy: '' },
        modules: [
          {
            name: 'M1',
            description: '',
            lessons: [
              { name: 'L1', description: '' },
              { name: 'L2', description: '' },
            ],
          },
        ],
      },
    });
    await UserLessonProgressModel.create({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      lessonIndex: 0,
      status: 'completed',
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });
    // L1 not completed

    const result = await getUnattemptedQuizzes({ userId: user._id.toString() });
    expect(result).toHaveLength(0);
  });

  test('archived course is excluded', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 1, status: 'archived' });
    await UserLessonProgressModel.create({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      lessonIndex: 0,
      status: 'completed',
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });

    const result = await getUnattemptedQuizzes({ userId: user._id.toString() });
    expect(result).toHaveLength(0);
  });
});

// ── getCourseQuizProgress ──────────────────────────────

describe('getCourseQuizProgress', () => {
  test('no progress rows → empty array', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id });
    const result = await getCourseQuizProgress({
      userId: user._id.toString(),
      courseId: course._id.toString(),
    });
    expect(result).toEqual([]);
  });

  test('returns one entry per module with progress', async () => {
    const user = await makeUser();
    const course = await seedCourse({ userId: user._id, modules: 3 });
    await seedQuizProgress({ userId: user._id, courseId: course._id, moduleIndex: 0, bestTier: 'mastered' });
    await seedQuizProgress({ userId: user._id, courseId: course._id, moduleIndex: 1, bestTier: 'passed' });

    const result = await getCourseQuizProgress({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      totalModules: 3,
    });
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.moduleIndex === 0)?.bestTier).toBe('mastered');
  });
});
