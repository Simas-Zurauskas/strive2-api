import mongoose from 'mongoose';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import CourseModel from '@models/CourseModel';
import {
  QuizMasteryTier,
  REVIEW_INITIAL_INTERVALS,
  REVIEW_PROGRESSION_GAPS,
} from '@lib/constants';

// ── Shared review-due computation ─────────────────────────

interface ReviewCheckInput {
  bestTier: QuizMasteryTier | null;
  attempts: { completedAt: Date }[];
  nextReviewAt: Date | null;
  moduleIndex: number;
}

interface ReviewCheckResult {
  effectiveReviewAt: Date | null;
  timeDue: boolean;
  progressionDue: boolean;
}

const checkReviewDue = (
  doc: ReviewCheckInput,
  maxModuleIndex: number,
  totalModules: number,
  now: Date,
): ReviewCheckResult => {
  if (!doc.bestTier || doc.attempts.length === 0) {
    return { effectiveReviewAt: null, timeDue: false, progressionDue: false };
  }

  // Time-based trigger (with back-population fallback)
  let effectiveReviewAt = doc.nextReviewAt;
  if (!effectiveReviewAt) {
    const lastAttempt = doc.attempts[doc.attempts.length - 1];
    const intervalDays = REVIEW_INITIAL_INTERVALS[doc.bestTier];
    effectiveReviewAt = new Date(lastAttempt.completedAt.getTime() + intervalDays * 24 * 60 * 60 * 1000);
  }
  const timeDue = effectiveReviewAt <= now;

  // Progression-based trigger (gap capped to totalModules - 1 for small courses)
  const rawGap = REVIEW_PROGRESSION_GAPS[doc.bestTier];
  const gap = Math.min(rawGap, Math.max(totalModules - 1, 1));
  const progressionDue = maxModuleIndex - doc.moduleIndex >= gap;

  return { effectiveReviewAt, timeDue, progressionDue };
};

// ── Course quiz progress ─────────────────────────────────

export interface CourseQuizProgressItem {
  moduleIndex: number;
  bestScore: number;
  bestTier: QuizMasteryTier | null;
  attemptCount: number;
  nextReviewAt: string | null;
  reviewDue: boolean;
}

export const getCourseQuizProgress = async (params: {
  userId: string;
  courseId: string;
  totalModules?: number;
}): Promise<CourseQuizProgressItem[]> => {
  const docs = await UserModuleQuizProgressModel.find({
    userId: params.userId,
    courseId: params.courseId,
  }).lean();

  const now = new Date();
  const maxModuleIndex = docs.length > 0 ? Math.max(...docs.map((d) => d.moduleIndex)) : -1;
  const totalMods = params.totalModules ?? maxModuleIndex + 1;

  return docs.map((d) => {
    const { effectiveReviewAt, timeDue, progressionDue } = checkReviewDue(d, maxModuleIndex, totalMods, now);

    return {
      moduleIndex: d.moduleIndex,
      bestScore: d.bestScore,
      bestTier: d.bestTier,
      attemptCount: d.attempts.length,
      nextReviewAt: effectiveReviewAt?.toISOString() ?? null,
      reviewDue: timeDue || progressionDue,
    };
  });
};

// ── Reviews due (cross-course) ────────────────────────────

export interface ReviewDueItem {
  courseId: string;
  courseSlug: string | null;
  courseName: string;
  moduleIndex: number;
  moduleName: string;
  bestScore: number;
  bestTier: QuizMasteryTier;
  nextReviewAt: string | null;
  reviewReason: 'time' | 'progression';
}

export const getReviewsDue = async (params: { userId: string }): Promise<ReviewDueItem[]> => {
  const now = new Date();

  const allDocs = await UserModuleQuizProgressModel.find({
    userId: params.userId,
  }).lean();

  if (allDocs.length === 0) return [];

  // Group by courseId
  const byCourse = new Map<string, typeof allDocs>();
  for (const doc of allDocs) {
    const key = doc.courseId.toString();
    if (!byCourse.has(key)) byCourse.set(key, []);
    byCourse.get(key)!.push(doc);
  }

  // Load course data for names and total module count
  const courseIds = [...byCourse.keys()];
  const courses = await CourseModel.find({ _id: { $in: courseIds } })
    .select('name slug structure')
    .lean();
  const courseMap = new Map(courses.map((c) => [c._id.toString(), c]));

  const results: ReviewDueItem[] = [];

  for (const [courseIdStr, docs] of byCourse) {
    const course = courseMap.get(courseIdStr);
    if (!course?.structure?.modules) continue;

    const maxModuleIndex = Math.max(...docs.map((d) => d.moduleIndex));
    const totalModules = course.structure.modules.length;

    for (const d of docs) {
      const { effectiveReviewAt, timeDue, progressionDue } = checkReviewDue(d, maxModuleIndex, totalModules, now);

      if (!timeDue && !progressionDue) continue;
      if (!d.bestTier) continue;

      const mod = course.structure.modules[d.moduleIndex];
      results.push({
        courseId: courseIdStr,
        courseSlug: course.slug ?? null,
        courseName: course.name || 'Untitled Course',
        moduleIndex: d.moduleIndex,
        moduleName: mod?.name || `Module ${d.moduleIndex + 1}`,
        bestScore: d.bestScore,
        bestTier: d.bestTier,
        nextReviewAt: effectiveReviewAt?.toISOString() ?? null,
        reviewReason: progressionDue ? 'progression' : 'time',
      });
    }
  }

  // Sort: progression-triggered first, then by review date (most overdue first)
  results.sort((a, b) => {
    if (a.reviewReason !== b.reviewReason) return a.reviewReason === 'progression' ? -1 : 1;
    return (a.nextReviewAt ?? '') < (b.nextReviewAt ?? '') ? -1 : 1;
  });

  return results;
};

// ── Unattempted quizzes (cross-course) ───────────────────

export interface UnattemptedQuizItem {
  courseId: string;
  courseSlug: string | null;
  courseName: string;
  moduleIndex: number;
  moduleName: string;
}

export const getUnattemptedQuizzes = async (params: { userId: string }): Promise<UnattemptedQuizItem[]> => {
  const userObjId = new mongoose.Types.ObjectId(params.userId);

  // Get all ready courses for this user
  const courses = await CourseModel.find({ userId: userObjId, status: 'ready' })
    .select('name slug structure')
    .lean();

  if (courses.length === 0) return [];

  const courseIds = courses.map((c) => c._id);

  // Get completed lesson counts grouped by course+module, and attempted quiz modules in parallel
  const [completedAgg, quizDocs] = await Promise.all([
    UserLessonProgressModel.aggregate([
      { $match: { userId: userObjId, courseId: { $in: courseIds }, status: 'completed' } },
      { $group: { _id: { courseId: '$courseId', moduleIndex: '$moduleIndex' }, count: { $sum: 1 } } },
    ]),
    UserModuleQuizProgressModel.find({ userId: params.userId, courseId: { $in: courseIds } })
      .select('courseId moduleIndex')
      .lean(),
  ]);

  // Build lookup sets
  const completedByModule = new Map<string, number>(
    completedAgg.map((a) => [`${a._id.courseId}-${a._id.moduleIndex}`, a.count as number]),
  );
  const attemptedQuizzes = new Set<string>(
    quizDocs.map((q) => `${q.courseId}-${q.moduleIndex}`),
  );

  const results: UnattemptedQuizItem[] = [];
  for (const course of courses) {
    if (!course.structure?.modules) continue;
    for (let mi = 0; mi < course.structure.modules.length; mi++) {
      const mod = course.structure.modules[mi];
      const totalLessons = mod.lessons?.length ?? 0;
      if (totalLessons === 0) continue;
      const completedLessons = completedByModule.get(`${course._id}-${mi}`) ?? 0;
      const key = `${course._id}-${mi}`;
      if (completedLessons >= totalLessons && !attemptedQuizzes.has(key)) {
        results.push({
          courseId: course._id.toString(),
          courseSlug: course.slug ?? null,
          courseName: course.name || 'Untitled Course',
          moduleIndex: mi,
          moduleName: mod.name || `Module ${mi + 1}`,
        });
      }
    }
  }

  return results;
};
