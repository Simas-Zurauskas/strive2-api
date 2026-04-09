import mongoose from 'mongoose';
import UserLessonProgressModel, { IUserLessonProgress } from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel, { IUserModuleQuizProgress, IQuizAttempt } from '@models/UserModuleQuizProgressModel';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import LessonContentModel from '@models/LessonContentModel';
import CourseModel from '@models/CourseModel';
import {
  LessonProgressStatus,
  QuizMasteryTier,
  REVIEW_INITIAL_INTERVALS,
  REVIEW_PROGRESSION_GAPS,
  REVIEW_MAX_INTERVAL_DAYS,
  REVIEW_MIN_INTERVAL_DAYS,
} from '@lib/constants';

// ── Status transition guard ───────────────────────────────

const STATUS_ORDER: Record<LessonProgressStatus, number> = {
  not_started: 0,
  in_progress: 1,
  completed: 2,
};

// ── Upsert ────────────────────────────────────────────────

interface UpsertParams {
  userId: string;
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
  status?: LessonProgressStatus;
  notes?: string | null;
  bookmarked?: boolean;
  timeSpentDelta?: number;
  quizResponse?: {
    blockId: string;
    selectedOption: number;
    correct: boolean;
  };
  exerciseAttempt?: {
    blockId: string;
    code: string;
    passed: boolean;
  };
}

export const upsertLessonProgress = async (params: UpsertParams): Promise<IUserLessonProgress> => {
  const { userId, courseId, moduleIndex, lessonIndex } = params;
  const now = new Date();

  // Build the update operations
  const $set: Record<string, unknown> = { lastAccessedAt: now };
  const $inc: Record<string, number> = {};
  const $push: Record<string, unknown> = {};
  const $setOnInsert: Record<string, unknown> = {
    userId: new mongoose.Types.ObjectId(userId),
    courseId: new mongoose.Types.ObjectId(courseId),
    moduleIndex,
    lessonIndex,
  };

  // Status: only transition forward
  if (params.status) {
    // We use a conditional update: only set status if the new status is "higher"
    // For upsert (new doc), $setOnInsert handles the initial value
    $setOnInsert.status = params.status;
  }

  if (params.notes !== undefined) {
    $set.notes = params.notes;
  }

  if (params.bookmarked !== undefined) {
    $set.bookmarked = params.bookmarked;
  }

  if (params.timeSpentDelta && params.timeSpentDelta > 0) {
    $inc.timeSpentSeconds = params.timeSpentDelta;
  }

  if (params.quizResponse) {
    $push.quizResponses = {
      ...params.quizResponse,
      answeredAt: now,
    };
  }

  if (params.exerciseAttempt) {
    $push.exerciseAttempts = {
      ...params.exerciseAttempt,
      attemptedAt: now,
    };
  }

  // Build the update object
  const update: Record<string, unknown> = { $set, $setOnInsert };
  if (Object.keys($inc).length > 0) update.$inc = $inc;
  if (Object.keys($push).length > 0) update.$push = $push;

  const doc = await UserLessonProgressModel.findOneAndUpdate(
    { userId, courseId, moduleIndex, lessonIndex },
    update,
    { upsert: true, returnDocument: 'after' },
  );

  // Handle status forward-only transition for existing docs
  if (params.status && doc) {
    const currentOrder = STATUS_ORDER[doc.status];
    const requestedOrder = STATUS_ORDER[params.status];

    if (requestedOrder > currentOrder) {
      doc.status = params.status;
      if (params.status === 'completed') {
        doc.completedAt = now;
      }
      await doc.save();
    }
  }

  return doc!.toJSON();
};

// ── Get course progress ───────────────────────────────────

export const getCourseProgress = async (params: {
  userId: string;
  courseId: string;
}): Promise<IUserLessonProgress[]> => {
  return UserLessonProgressModel.find({
    userId: params.userId,
    courseId: params.courseId,
  }).lean();
};

// ── Continue learning ─────────────────────────────────────

interface ContinueLearningResult {
  courseId: string;
  courseName: string;
  courseGoal: string;
  moduleName: string;
  lessonName: string;
  moduleIndex: number;
  lessonIndex: number;
  courseProgress: { total: number; completed: number; percentage: number };
}

export const getContinueLearning = async (params: {
  userId: string;
}): Promise<ContinueLearningResult | null> => {
  // Find most recently accessed lesson
  const latest = await UserLessonProgressModel.findOne({ userId: params.userId })
    .sort({ lastAccessedAt: -1 })
    .lean();

  if (!latest) return null;

  // Get the course for context
  const course = await CourseModel.findById(latest.courseId).lean();
  if (!course?.structure?.modules) return null;

  const mod = course.structure.modules[latest.moduleIndex];
  const lesson = mod?.lessons?.[latest.lessonIndex];
  if (!mod || !lesson) return null;

  // Compute course progress
  const totalLessons = course.structure.modules.reduce(
    (sum, m) => sum + (m.lessons?.length ?? 0),
    0,
  );
  const completedCount = await UserLessonProgressModel.countDocuments({
    userId: params.userId,
    courseId: latest.courseId,
    status: 'completed',
  });

  return {
    courseId: latest.courseId.toString(),
    courseName: course.name,
    courseGoal: course.goal,
    moduleName: mod.name,
    lessonName: lesson.name,
    moduleIndex: latest.moduleIndex,
    lessonIndex: latest.lessonIndex,
    courseProgress: {
      total: totalLessons,
      completed: completedCount,
      percentage: totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0,
    },
  };
};

// ── Generated lessons ─────────────────────────────────────

export const getGeneratedLessons = async (params: {
  courseId: string;
}): Promise<{ moduleIndex: number; lessonIndex: number }[]> => {
  return LessonContentModel.find({ courseId: params.courseId })
    .select('moduleIndex lessonIndex')
    .lean()
    .then((docs) => docs.map((d) => ({ moduleIndex: d.moduleIndex, lessonIndex: d.lessonIndex })));
};

// ── Progress summary (all courses) ────────────────────────

interface ProgressSummaryItem {
  courseId: string;
  total: number;
  completed: number;
  percentage: number;
  lastModuleIndex: number | null;
  lastLessonIndex: number | null;
}

export const getProgressSummary = async (params: {
  userId: string;
}): Promise<ProgressSummaryItem[]> => {
  const userObjId = new mongoose.Types.ObjectId(params.userId);

  // Get completed counts + last accessed lesson per course in parallel
  const [completedAgg, lastAccessedAgg] = await Promise.all([
    UserLessonProgressModel.aggregate([
      { $match: { userId: userObjId, status: 'completed' } },
      { $group: { _id: '$courseId', completed: { $sum: 1 } } },
    ]),
    UserLessonProgressModel.aggregate([
      { $match: { userId: userObjId } },
      { $sort: { lastAccessedAt: -1 } },
      {
        $group: {
          _id: '$courseId',
          lastModuleIndex: { $first: '$moduleIndex' },
          lastLessonIndex: { $first: '$lessonIndex' },
        },
      },
    ]),
  ]);

  // Build last-accessed lookup
  const lastAccessedMap = new Map(
    lastAccessedAgg.map((a) => [
      a._id.toString(),
      { moduleIndex: a.lastModuleIndex as number, lessonIndex: a.lastLessonIndex as number },
    ]),
  );

  // Collect all course IDs from both aggregations
  const courseIdSet = new Set<string>();
  for (const a of completedAgg) courseIdSet.add(a._id.toString());
  for (const a of lastAccessedAgg) courseIdSet.add(a._id.toString());

  if (courseIdSet.size === 0) return [];

  const courseIds = [...courseIdSet].map((id) => new mongoose.Types.ObjectId(id));
  const courses = await CourseModel.find({ _id: { $in: courseIds } })
    .select('structure')
    .lean();

  const courseMap = new Map(courses.map((c) => [c._id.toString(), c]));
  const completedMap = new Map(completedAgg.map((a) => [a._id.toString(), a.completed as number]));

  return [...courseIdSet].map((id) => {
    const course = courseMap.get(id);
    const total = course?.structure?.modules?.reduce(
      (sum, m) => sum + (m.lessons?.length ?? 0),
      0,
    ) ?? 0;
    const completed = completedMap.get(id) ?? 0;
    const lastAccessed = lastAccessedMap.get(id);

    return {
      courseId: id,
      total,
      completed,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
      lastModuleIndex: lastAccessed?.moduleIndex ?? null,
      lastLessonIndex: lastAccessed?.lessonIndex ?? null,
    };
  });
};

// ── Module quiz progress ────────────────────────────────

const computeMasteryTier = (score: number): QuizMasteryTier => {
  if (score >= 80) return 'mastered';
  if (score >= 60) return 'passed';
  return 'needs_review';
};

export const getModuleQuizProgress = async (params: {
  userId: string;
  courseId: string;
  moduleIndex: number;
}): Promise<IUserModuleQuizProgress | null> => {
  return UserModuleQuizProgressModel.findOne({
    userId: params.userId,
    courseId: params.courseId,
    moduleIndex: params.moduleIndex,
  }).lean();
};

interface SubmitQuizAttemptParams {
  userId: string;
  courseId: string;
  moduleIndex: number;
  responses: { questionId: string; selectedOption: number }[];
}

export interface SubmitQuizAttemptResult {
  attempt: IQuizAttempt;
  nextReviewAt: Date;
  reviewIntervalDays: number;
}

// Mastery tier ordering for regression detection
const TIER_ORDER: Record<QuizMasteryTier, number> = { needs_review: 0, passed: 1, mastered: 2 };

export const submitQuizAttempt = async (params: SubmitQuizAttemptParams): Promise<SubmitQuizAttemptResult> => {
  const { userId, courseId, moduleIndex, responses } = params;
  const now = new Date();

  // Load quiz content to grade answers
  const quizContent = await ModuleQuizContentModel.findOne({ courseId, moduleIndex }).lean();
  if (!quizContent) throw new Error('Quiz content not found');

  if (responses.length !== quizContent.questions.length) {
    throw new Error(`Expected ${quizContent.questions.length} responses, got ${responses.length}`);
  }

  // Grade each response
  const gradedResponses = responses.map((r) => {
    const question = quizContent.questions.find((q) => q.id === r.questionId);
    return {
      questionId: r.questionId,
      selectedOption: r.selectedOption,
      correct: question ? r.selectedOption === question.correctIndex : false,
      answeredAt: now,
    };
  });

  const correctCount = gradedResponses.filter((r) => r.correct).length;
  const score = Math.round((correctCount / quizContent.questions.length) * 100);
  const masteryTier = computeMasteryTier(score);

  // Get current progress to determine attempt number + review state
  const existing = await UserModuleQuizProgressModel.findOne({ userId, courseId, moduleIndex });
  const attemptNumber = existing ? existing.attempts.length + 1 : 1;
  const previousBestTier = existing?.bestTier ?? null;

  const attempt: IQuizAttempt = {
    attemptNumber,
    responses: gradedResponses,
    score,
    masteryTier,
    completedAt: now,
    quizVersion: quizContent.version,
  };

  // Upsert progress: push attempt, update best score/tier
  const bestScore = existing ? Math.max(existing.bestScore, score) : score;
  const bestTier = computeMasteryTier(bestScore);

  // Compute review scheduling
  let reviewIntervalDays: number;
  let consecutiveSuccesses: number;

  if (!existing || !previousBestTier) {
    // First attempt — set initial interval based on tier
    reviewIntervalDays = REVIEW_INITIAL_INTERVALS[masteryTier];
    consecutiveSuccesses = 0;
  } else if (TIER_ORDER[masteryTier] >= TIER_ORDER[previousBestTier]) {
    // Maintained or improved — double the interval
    const prev = existing.reviewIntervalDays || REVIEW_INITIAL_INTERVALS[previousBestTier];
    reviewIntervalDays = Math.min(prev * 2, REVIEW_MAX_INTERVAL_DAYS);
    consecutiveSuccesses = (existing.consecutiveSuccesses || 0) + 1;
  } else {
    // Regressed — halve the interval
    const prev = existing.reviewIntervalDays || REVIEW_INITIAL_INTERVALS[previousBestTier];
    reviewIntervalDays = Math.max(Math.floor(prev / 2), REVIEW_MIN_INTERVAL_DAYS);
    consecutiveSuccesses = 0;
  }

  const nextReviewAt = new Date(now.getTime() + reviewIntervalDays * 24 * 60 * 60 * 1000);

  await UserModuleQuizProgressModel.findOneAndUpdate(
    { userId, courseId, moduleIndex },
    {
      $push: { attempts: attempt },
      $set: {
        bestScore,
        bestTier,
        reviewIntervalDays,
        consecutiveSuccesses,
        nextReviewAt,
      },
      $setOnInsert: {
        userId: new mongoose.Types.ObjectId(userId),
        courseId: new mongoose.Types.ObjectId(courseId),
        moduleIndex,
      },
    },
    { upsert: true },
  );

  return { attempt, nextReviewAt, reviewIntervalDays };
};

export interface CourseQuizProgressItem {
  moduleIndex: number;
  bestScore: number;
  bestTier: QuizMasteryTier | null;
  attemptCount: number;
  nextReviewAt: string | null;
  reviewDue: boolean;
}

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
    .select('name structure')
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
