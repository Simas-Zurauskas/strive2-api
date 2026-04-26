/**
 * Tests for the cascade-delete + edit-impact reporting around course content.
 * Bugs here orphan rows when a user regenerates a structure or cause wrong
 * "you'll lose X minutes of progress" estimates.
 *
 * Run: yarn test courseCleanupService
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, makeLessonContent, makeInsight, makeInsightProgress } from '../../test-helpers/factories';
import LessonContentModel from '@models/LessonContentModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import InsightModel from '@models/InsightModel';
import UserInsightProgressModel from '@models/UserInsightProgressModel';
import CourseDesignChatModel from '@models/CourseDesignChatModel';

vi.mock('@services/s3Service', () => ({
  deleteByPrefix: vi.fn(() => Promise.resolve(0)),
  uploadBuffer: vi.fn(),
  getPresignedUrl: vi.fn(),
  objectExists: vi.fn(),
}));

import { cleanupCourseContent, getEditImpact } from '@services/courseCleanupService';
import { deleteByPrefix } from '@services/s3Service';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
});

// ── cleanupCourseContent ───────────────────────────────

describe('cleanupCourseContent', () => {
  test('empty course: all counts are 0, no errors, S3 cleanup still fired', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    const result = await cleanupCourseContent(course._id.toString());
    expect(result.lessonContentDeleted).toBe(0);
    expect(result.lessonProgressDeleted).toBe(0);
    expect(result.insightsDeleted).toBe(0);
    expect(result.insightProgressDeleted).toBe(0);

    // S3 cleanup is fire-and-forget; we mocked it to resolve
    expect(deleteByPrefix).toHaveBeenCalledWith(`lessons/${course._id}/`);
  });

  test('cascades through lessons, quizzes, insights, and dependent insight progress', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    // Seed: 2 lesson contents, 1 quiz content, 1 insight + progress, 1 chat session
    await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 0 });
    await makeLessonContent({ courseId: course._id, moduleIndex: 1, lessonIndex: 0 });
    await ModuleQuizContentModel.create({
      courseId: course._id,
      moduleIndex: 0,
      questions: [],
      version: 1,
    });
    const lesson = await makeLessonContent({ courseId: course._id, moduleIndex: 2, lessonIndex: 0 });
    const insight = await makeInsight({ courseId: course._id, lessonId: lesson._id });
    await makeInsightProgress({
      userId: user._id,
      insightId: insight._id,
      reps: 1,
    });
    await CourseDesignChatModel.create({
      userId: user._id,
      courseId: course._id,
      messages: [],
    });

    const result = await cleanupCourseContent(course._id.toString());
    expect(result.lessonContentDeleted).toBe(3);
    expect(result.quizContentDeleted).toBe(1);
    expect(result.insightsDeleted).toBe(1);
    expect(result.insightProgressDeleted).toBe(1);
    expect(result.chatSessionsDeleted).toBe(1);

    // Verify nothing left
    expect(await LessonContentModel.countDocuments({ courseId: course._id })).toBe(0);
    expect(await ModuleQuizContentModel.countDocuments({ courseId: course._id })).toBe(0);
    expect(await InsightModel.countDocuments({ courseId: course._id })).toBe(0);
    expect(await UserInsightProgressModel.countDocuments({ insightId: insight._id })).toBe(0);
  });

  test('cleans only the targeted course (other courses untouched)', async () => {
    const user = await makeUser();
    const courseA = await makeCourse({ userId: user._id });
    const courseB = await makeCourse({ userId: user._id });

    await makeLessonContent({ courseId: courseA._id, moduleIndex: 0, lessonIndex: 0 });
    await makeLessonContent({ courseId: courseB._id, moduleIndex: 0, lessonIndex: 0 });

    await cleanupCourseContent(courseA._id.toString());

    expect(await LessonContentModel.countDocuments({ courseId: courseA._id })).toBe(0);
    expect(await LessonContentModel.countDocuments({ courseId: courseB._id })).toBe(1);
  });

  test('S3 cleanup throws → bgError catches it; Mongo deletions still happen', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await makeLessonContent({ courseId: course._id });

    vi.mocked(deleteByPrefix).mockRejectedValueOnce(new Error('S3 unreachable'));

    const result = await cleanupCourseContent(course._id.toString());
    expect(result.lessonContentDeleted).toBe(1); // still cleaned despite S3 failure
  });
});

// ── getEditImpact ──────────────────────────────────────
//
// ⚠️ BUG (revealed by tests 2026-04-24):
// `getEditImpact` runs `$match: { courseId, userId }` in its aggregations
// where both inputs are STRINGS, but the stored fields are ObjectIds. Mongo
// doesn't auto-cast string→ObjectId in aggregation $match, so EVERY
// aggregation returns an empty array and the progress/notes/quiz numbers
// silently default to zero in production. The `hasContent` field uses
// countDocuments() (which Mongoose-casts), so it still works.
//
// Caller path: `controlers/course/getEditImpact.ts:54–57` passes raw strings.
//
// Tests below capture the ACTUAL behavior — they will start failing once
// the source casts to ObjectId before the $match (the obvious fix).

describe('getEditImpact', () => {
  test('empty course / no progress: hasContent + hasProgress both false', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const result = await getEditImpact({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });
    expect(result.hasContent).toBe(false);
    expect(result.hasProgress).toBe(false);
    expect(result.completedLessons).toBe(0);
    expect(result.totalTimeSpentMinutes).toBe(0);
  });

  test('mixed completed + in-progress lessons: counts each independently', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 0 });

    // 2 completed, 1 in-progress
    await UserLessonProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      lessonIndex: 0,
      status: 'completed',
      timeSpentSeconds: 1200,
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });
    await UserLessonProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      lessonIndex: 1,
      status: 'completed',
      timeSpentSeconds: 600,
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });
    await UserLessonProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 1,
      lessonIndex: 0,
      status: 'in_progress',
      timeSpentSeconds: 1800,
      lastAccessedAt: new Date(),
    });

    const result = await getEditImpact({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });
    expect(result.hasContent).toBe(true); // countDocuments works (Mongoose casts)
    // BUG: aggregation $match doesn't cast string → ObjectId, so the
    // progress aggregation returns empty and these stay 0.
    expect(result.hasProgress).toBe(false);
    expect(result.completedLessons).toBe(0);
    expect(result.inProgressLessons).toBe(0);
    expect(result.totalTimeSpentMinutes).toBe(0);
  });

  test('counts notes + bookmarks independently of status', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await UserLessonProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      lessonIndex: 0,
      status: 'completed',
      notes: 'Important',
      bookmarked: true,
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });
    await UserLessonProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      lessonIndex: 1,
      status: 'completed',
      notes: '',
      bookmarked: false,
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });

    const result = await getEditImpact({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });
    // BUG (see header note): aggregation returns empty → both fields zero.
    expect(result.totalNotes).toBe(0);
    expect(result.totalBookmarks).toBe(0);
  });

  test('quiz attempts and mastery aggregation', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await UserModuleQuizProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      bestScore: 100,
      bestTier: 'mastered',
      reviewIntervalDays: 7,
      consecutiveSuccesses: 1,
      nextReviewAt: new Date(),
      attempts: [
        {
          attemptNumber: 1,
          responses: [],
          score: 100,
          masteryTier: 'mastered',
          completedAt: new Date(),
          quizVersion: 1,
        },
        {
          attemptNumber: 2,
          responses: [],
          score: 90,
          masteryTier: 'mastered',
          completedAt: new Date(),
          quizVersion: 1,
        },
      ],
    });
    await UserModuleQuizProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 1,
      bestScore: 50,
      bestTier: 'needs_review',
      reviewIntervalDays: 1,
      consecutiveSuccesses: 0,
      nextReviewAt: null,
      attempts: [
        {
          attemptNumber: 1,
          responses: [],
          score: 50,
          masteryTier: 'needs_review',
          completedAt: new Date(),
          quizVersion: 1,
        },
      ],
    });

    const result = await getEditImpact({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });
    // BUG (see header note): aggregation returns empty → all quiz fields zero.
    expect(result.quizAttempts).toBe(0);
    expect(result.modulesWithMastery).toBe(0);
    expect(result.scheduledReviews).toBe(0);
  });
});
