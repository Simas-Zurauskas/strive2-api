import mongoose from 'mongoose';
import UserLessonProgressModel, { IUserLessonProgress } from '@models/UserLessonProgressModel';
import LessonContentModel from '@models/LessonContentModel';
import CourseModel from '@models/CourseModel';
import { LessonProgressStatus } from '@lib/constants';
import { bgError } from '@lib/bg';
import * as gamificationService from '@services/gamificationService';

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

  // Atomic forward-only status promotion.
  //
  // Previously this read the post-upsert doc, compared STATUS_ORDER in JS,
  // and called doc.save(). Two concurrent calls (one in_progress, one
  // completed) could both read the same pre-state and both save, letting
  // the lower status overwrite the higher one. That also meant the
  // gamification side-effect could fire zero or two times for a single
  // user-visible completion.
  //
  // Now: a single conditional updateOne with a filter on the *current*
  // status-order set. Mongo's per-document locking guarantees only one
  // concurrent caller's filter will match, so modifiedCount === 1 is an
  // unambiguous signal that THIS call was the one that advanced the state.
  if (params.status) {
    const requestedOrder = STATUS_ORDER[params.status];
    const statusesBelow = (Object.keys(STATUS_ORDER) as LessonProgressStatus[]).filter(
      (s) => STATUS_ORDER[s] < requestedOrder,
    );

    if (statusesBelow.length > 0) {
      const promotion = await UserLessonProgressModel.updateOne(
        { userId, courseId, moduleIndex, lessonIndex, status: { $in: statusesBelow } },
        {
          $set: {
            status: params.status,
            ...(params.status === 'completed' ? { completedAt: now } : {}),
          },
        },
      );

      if (promotion.modifiedCount > 0) {
        // Reflect the promotion in the returned doc so the API response
        // matches the new state without a second read.
        if (doc) {
          doc.status = params.status;
          if (params.status === 'completed') doc.completedAt = now;
        }
        if (params.status === 'completed') {
          // Fire-and-forget gamification — exactly once per real transition.
          gamificationService.onLessonComplete({ userId, courseId }).catch(bgError('gamification.onLessonComplete'));
        }
      }
    }
  }

  // Fire-and-forget gamification for first exercise pass
  if (params.exerciseAttempt?.passed) {
    gamificationService.onExercisePass(userId).catch(bgError('gamification.onExercisePass'));
  }

  // Record streak activity for any meaningful interaction
  // Lesson completion already records activity via onLessonComplete, so skip if that fired
  const completionFired = params.status === 'completed';
  const hadMeaningfulInteraction = params.status === 'in_progress' || params.timeSpentDelta || params.quizResponse || params.exerciseAttempt;
  if (!completionFired && hadMeaningfulInteraction) {
    gamificationService.recordActivity(userId).catch(bgError('gamification.recordActivity'));
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
  courseSlug: string | null;
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
    courseSlug: course.slug ?? null,
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
  return LessonContentModel.find({ courseId: params.courseId, completed: true })
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

