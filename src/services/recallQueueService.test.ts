/**
 * Tests for `getRecallQueue`. The composition logic has three load-bearing
 * gates:
 *   1. Archive filter — archived courses' recall cards never surface
 *   2. Fresh-pool threshold — fresh items only fill in when due < 20
 *   3. Completed-lesson gate (fresh only) — never surface a card from an
 *      unread lesson
 * Plus round-robin interleaving across courses.
 *
 * Run: yarn test recallQueueService
 */

import assert from 'node:assert/strict';
import { describe, test, expect } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import {
  makeUser,
  makeCourse,
  makeLessonContent,
  makeRecallCard,
  makeRecallProgress,
  CourseModel,
} from '../../test-helpers/factories';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import {
  RECALL_QUEUE_DUE_LIMIT,
  RECALL_QUEUE_FRESH_LIMIT_DEFAULT,
  RECALL_QUEUE_FRESH_THRESHOLD,
} from '@lib/recallConstants';

import { getRecallQueue } from '@services/recallQueueService';

setupTestDb();

const seedCourseWithStructure = async (params: {
  userId: mongoose.Types.ObjectId;
  status?: 'creating' | 'ready' | 'archived';
  modules: { name: string; lessons: { name: string }[] }[];
}) => {
  return makeCourse({
    userId: params.userId,
    status: params.status ?? 'ready',
    structure: {
      reasoning: {
        learnerProfile: '',
        topicAnalysis: '',
        scopeDecisions: '',
        progressionStrategy: '',
      },
      modules: params.modules.map((m) => ({
        name: m.name,
        description: '',
        lessons: m.lessons.map((l) => ({ name: l.name, description: '' })),
      })),
    },
  });
};

const completeLesson = async (params: {
  userId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  moduleIndex: number;
  lessonIndex: number;
}) => {
  await UserLessonProgressModel.create({
    userId: params.userId,
    courseId: params.courseId,
    moduleIndex: params.moduleIndex,
    lessonIndex: params.lessonIndex,
    status: 'completed',
    lastAccessedAt: new Date(),
    completedAt: new Date(),
  });
};

// ── Empty cases ─────────────────────────────────────────

describe('getRecallQueue — empty cases', () => {
  test('user with no courses: empty queue', async () => {
    const user = await makeUser();
    const result = await getRecallQueue({ userId: user._id.toString() });
    expect(result.due).toEqual([]);
    expect(result.fresh).toEqual([]);
    expect(result.counts.dueTotal).toBe(0);
    expect(result.counts.freshAvailable).toBe(0);
  });
});

// ── Due pool ────────────────────────────────────────────

describe('getRecallQueue — due pool', () => {
  test('returns recall cards with nextDue <= now in priority order', async () => {
    const user = await makeUser();
    const course = await seedCourseWithStructure({
      userId: user._id,
      modules: [{ name: 'M1', lessons: [{ name: 'L1' }, { name: 'L2' }] }],
    });
    const l1 = await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 0 });
    const l2 = await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 1 });
    const i1 = await makeRecallCard({ courseId: course._id, lessonId: l1._id, lessonIndex: 0 });
    const i2 = await makeRecallCard({ courseId: course._id, lessonId: l2._id, lessonIndex: 1 });

    // i2 due now, i1 due 1 hour ago
    await makeRecallProgress({
      userId: user._id,
      recallCardId: i1._id,
      reps: 2,
      nextDue: new Date(Date.now() - 60 * 60 * 1000),
    });
    await makeRecallProgress({
      userId: user._id,
      recallCardId: i2._id,
      reps: 2,
      nextDue: new Date(Date.now() - 5 * 60 * 1000),
    });

    const result = await getRecallQueue({ userId: user._id.toString() });
    expect(result.due).toHaveLength(2);
    // Sorted by nextDue ascending — i1 (older overdue) first
    expect(result.due[0].recallCardId).toBe(i1._id.toString());
    expect(result.counts.dueTotal).toBe(2);
  });

  test('items with nextDue in the future are NOT in the due pool', async () => {
    const user = await makeUser();
    const course = await seedCourseWithStructure({
      userId: user._id,
      modules: [{ name: 'M1', lessons: [{ name: 'L1' }] }],
    });
    const lesson = await makeLessonContent({ courseId: course._id });
    const card = await makeRecallCard({ courseId: course._id, lessonId: lesson._id });
    await makeRecallProgress({
      userId: user._id,
      recallCardId: card._id,
      reps: 1,
      nextDue: new Date(Date.now() + 60 * 60 * 1000), // 1h in future
    });

    const result = await getRecallQueue({ userId: user._id.toString() });
    expect(result.due).toHaveLength(0);
  });

  test('archived course: due items are filtered OUT', async () => {
    const user = await makeUser();
    const course = await seedCourseWithStructure({
      userId: user._id,
      status: 'archived',
      modules: [{ name: 'M1', lessons: [{ name: 'L1' }] }],
    });
    const lesson = await makeLessonContent({ courseId: course._id });
    const card = await makeRecallCard({ courseId: course._id, lessonId: lesson._id });
    await makeRecallProgress({
      userId: user._id,
      recallCardId: card._id,
      reps: 1,
      nextDue: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await getRecallQueue({ userId: user._id.toString() });
    expect(result.due).toHaveLength(0);
    expect(result.counts.dueTotal).toBe(0);
  });

  test('due pool capped at RECALL_QUEUE_DUE_LIMIT', async () => {
    const user = await makeUser();
    const course = await seedCourseWithStructure({
      userId: user._id,
      modules: [
        {
          name: 'M1',
          lessons: Array.from({ length: 30 }, (_, i) => ({ name: `L${i}` })),
        },
      ],
    });

    // Create 30 recall cards, all due
    for (let i = 0; i < 30; i++) {
      const lesson = await makeLessonContent({
        courseId: course._id,
        lessonIndex: i,
      });
      const card = await makeRecallCard({
        courseId: course._id,
        lessonId: lesson._id,
        lessonIndex: i,
      });
      await makeRecallProgress({
        userId: user._id,
        recallCardId: card._id,
        reps: 1,
        nextDue: new Date(Date.now() - i * 60_000),
      });
    }

    const result = await getRecallQueue({ userId: user._id.toString() });
    expect(result.due).toHaveLength(RECALL_QUEUE_DUE_LIMIT);
    expect(result.counts.dueTotal).toBe(30); // total count is unbounded by the cap
  });
});

// ── Fresh pool gating ──────────────────────────────────

describe('getRecallQueue — fresh pool gating', () => {
  test('fresh pool suppressed when due >= RECALL_QUEUE_FRESH_THRESHOLD', async () => {
    const user = await makeUser();
    const course = await seedCourseWithStructure({
      userId: user._id,
      modules: [
        {
          name: 'M1',
          lessons: Array.from({ length: 30 }, (_, i) => ({ name: `L${i}` })),
        },
      ],
    });

    // Seed `RECALL_QUEUE_FRESH_THRESHOLD` due recall cards to trigger suppression
    for (let i = 0; i < RECALL_QUEUE_FRESH_THRESHOLD; i++) {
      const lesson = await makeLessonContent({ courseId: course._id, lessonIndex: i });
      const card = await makeRecallCard({
        courseId: course._id,
        lessonId: lesson._id,
        lessonIndex: i,
      });
      await makeRecallProgress({
        userId: user._id,
        recallCardId: card._id,
        reps: 1,
        nextDue: new Date(Date.now() - 60_000),
      });
    }

    // Add a fresh (no-progress) recall card in a completed lesson
    const freshLesson = await makeLessonContent({
      courseId: course._id,
      lessonIndex: RECALL_QUEUE_FRESH_THRESHOLD,
    });
    await makeRecallCard({
      courseId: course._id,
      lessonId: freshLesson._id,
      lessonIndex: RECALL_QUEUE_FRESH_THRESHOLD,
    });
    await completeLesson({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      lessonIndex: RECALL_QUEUE_FRESH_THRESHOLD,
    });

    const result = await getRecallQueue({ userId: user._id.toString() });
    expect(result.due).toHaveLength(RECALL_QUEUE_FRESH_THRESHOLD);
    // Fresh pool is empty because due >= threshold
    expect(result.fresh).toHaveLength(0);
  });

  test('fresh pool fills up to RECALL_QUEUE_FRESH_LIMIT_DEFAULT when due < threshold', async () => {
    const user = await makeUser();
    const course = await seedCourseWithStructure({
      userId: user._id,
      modules: [
        {
          name: 'M1',
          lessons: Array.from({ length: 10 }, (_, i) => ({ name: `L${i}` })),
        },
      ],
    });

    // 10 fresh recall cards, all in completed lessons
    for (let i = 0; i < 10; i++) {
      const lesson = await makeLessonContent({ courseId: course._id, lessonIndex: i });
      await makeRecallCard({
        courseId: course._id,
        lessonId: lesson._id,
        lessonIndex: i,
      });
      await completeLesson({
        userId: user._id,
        courseId: course._id,
        moduleIndex: 0,
        lessonIndex: i,
      });
    }

    const result = await getRecallQueue({ userId: user._id.toString() });
    expect(result.due).toHaveLength(0);
    expect(result.fresh.length).toBeLessThanOrEqual(RECALL_QUEUE_FRESH_LIMIT_DEFAULT);
    expect(result.fresh.length).toBeGreaterThan(0);
  });

  test('fresh pool gated by completed-lesson set: recall cards from unread lessons are filtered', async () => {
    const user = await makeUser();
    const course = await seedCourseWithStructure({
      userId: user._id,
      modules: [{ name: 'M1', lessons: [{ name: 'L1' }, { name: 'L2' }] }],
    });

    // Two fresh recall cards — but only L1 is completed
    const l1 = await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 0 });
    const l2 = await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 1 });
    const i1 = await makeRecallCard({ courseId: course._id, lessonId: l1._id, lessonIndex: 0 });
    const i2 = await makeRecallCard({ courseId: course._id, lessonId: l2._id, lessonIndex: 1 });

    await completeLesson({
      userId: user._id,
      courseId: course._id,
      moduleIndex: 0,
      lessonIndex: 0,
    });
    // L2 not completed

    const result = await getRecallQueue({ userId: user._id.toString() });
    const freshIds = result.fresh.map((f) => f.recallCardId);
    expect(freshIds).toContain(i1._id.toString());
    expect(freshIds).not.toContain(i2._id.toString()); // gated by completed-lesson check
  });

  test('fresh pool empty when no lessons completed', async () => {
    const user = await makeUser();
    const course = await seedCourseWithStructure({
      userId: user._id,
      modules: [{ name: 'M1', lessons: [{ name: 'L1' }] }],
    });
    const lesson = await makeLessonContent({ courseId: course._id });
    await makeRecallCard({ courseId: course._id, lessonId: lesson._id });
    // No UserLessonProgressModel rows — nothing completed

    const result = await getRecallQueue({ userId: user._id.toString() });
    expect(result.fresh).toHaveLength(0);
  });
});

// ── Round-robin interleaving ───────────────────────────

describe('getRecallQueue — interleaving', () => {
  test('due items round-robin across multiple courses', async () => {
    const user = await makeUser();
    const courseA = await seedCourseWithStructure({
      userId: user._id,
      modules: [{ name: 'M1', lessons: [{ name: 'A1' }, { name: 'A2' }, { name: 'A3' }] }],
    });
    const courseB = await seedCourseWithStructure({
      userId: user._id,
      modules: [{ name: 'M1', lessons: [{ name: 'B1' }] }],
    });

    // 3 due in courseA, 1 due in courseB
    for (let i = 0; i < 3; i++) {
      const lesson = await makeLessonContent({ courseId: courseA._id, lessonIndex: i });
      const card = await makeRecallCard({
        courseId: courseA._id,
        lessonId: lesson._id,
        lessonIndex: i,
      });
      await makeRecallProgress({
        userId: user._id,
        recallCardId: card._id,
        reps: 1,
        nextDue: new Date(Date.now() - 60_000),
      });
    }
    const lessonB = await makeLessonContent({ courseId: courseB._id });
    const cardB = await makeRecallCard({ courseId: courseB._id, lessonId: lessonB._id });
    await makeRecallProgress({
      userId: user._id,
      recallCardId: cardB._id,
      reps: 1,
      nextDue: new Date(Date.now() - 60_000),
    });

    const result = await getRecallQueue({ userId: user._id.toString() });
    // Round-robin: A, B, A, A (courseB exhausts after first slot)
    expect(result.due).toHaveLength(4);
    const courseSequence = result.due.map((d) => d.courseId);
    expect(courseSequence[0]).not.toBe(courseSequence[1]); // first two alternate
  });
});

// ── Counts ─────────────────────────────────────────────

describe('getRecallQueue — counts', () => {
  test('learned count is the number of recall cards with reps >= 1 across active courses', async () => {
    const user = await makeUser();
    const course = await seedCourseWithStructure({
      userId: user._id,
      modules: [{ name: 'M1', lessons: [{ name: 'L1' }, { name: 'L2' }, { name: 'L3' }] }],
    });

    for (let i = 0; i < 3; i++) {
      const lesson = await makeLessonContent({ courseId: course._id, lessonIndex: i });
      const card = await makeRecallCard({
        courseId: course._id,
        lessonId: lesson._id,
        lessonIndex: i,
      });
      await makeRecallProgress({
        userId: user._id,
        recallCardId: card._id,
        reps: i === 2 ? 0 : 1, // 2 with reps>=1, 1 with reps=0
        nextDue: new Date(Date.now() + 86400_000),
      });
    }

    const result = await getRecallQueue({ userId: user._id.toString() });
    expect(result.counts.learned).toBe(2);
  });
});
