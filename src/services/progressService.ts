import mongoose from 'mongoose';
import UserLessonProgressModel, { IUserLessonProgress } from '@models/UserLessonProgressModel';
import LessonContentModel from '@models/LessonContentModel';
import CourseModel from '@models/CourseModel';
import { LessonProgressStatus } from '@lib/constants';

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
    { upsert: true, new: true },
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
}

export const getProgressSummary = async (params: {
  userId: string;
}): Promise<ProgressSummaryItem[]> => {
  // Get completed counts per course
  const aggregation = await UserLessonProgressModel.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(params.userId), status: 'completed' } },
    { $group: { _id: '$courseId', completed: { $sum: 1 } } },
  ]);

  if (aggregation.length === 0) return [];

  // Get courses to calculate totals
  const courseIds = aggregation.map((a) => a._id);
  const courses = await CourseModel.find({ _id: { $in: courseIds } })
    .select('structure')
    .lean();

  const courseMap = new Map(courses.map((c) => [c._id.toString(), c]));

  return aggregation.map((agg) => {
    const course = courseMap.get(agg._id.toString());
    const total = course?.structure?.modules?.reduce(
      (sum, m) => sum + (m.lessons?.length ?? 0),
      0,
    ) ?? 0;

    return {
      courseId: agg._id.toString(),
      total,
      completed: agg.completed,
      percentage: total > 0 ? Math.round((agg.completed / total) * 100) : 0,
    };
  });
};
