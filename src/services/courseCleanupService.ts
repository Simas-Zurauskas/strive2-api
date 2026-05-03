import CourseDesignChatModel from '@models/CourseDesignChatModel';
import CourseMentorChatModel from '@models/CourseMentorChatModel';
import LessonContentModel from '@models/LessonContentModel';
import LessonMentorChatModel from '@models/LessonMentorChatModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import InsightModel from '@models/InsightModel';
import UserInsightProgressModel from '@models/UserInsightProgressModel';
import { deleteByPrefix } from '@services/s3Service';
import { deleteLessonChunksForCourse } from '@services/lessonRagService';
import { bgError } from '@lib/bg';
import { jobLog, integrationLog } from '@lib/loggers';

export interface CleanupResult {
  chatSessionsDeleted: number;
  mentorChatsDeleted: number;
  courseMentorChatsDeleted: number;
  lessonContentDeleted: number;
  lessonProgressDeleted: number;
  quizContentDeleted: number;
  quizProgressDeleted: number;
  insightsDeleted: number;
  insightProgressDeleted: number;
  ragChunksDeleted: number;
  ragVectorsDeleted: number;
}

/**
 * Deletes all generated content and user progress for a course.
 * Used when course structure changes (regeneration, refinement, edit mode)
 * to prevent orphaned data keyed by stale module/lesson indices.
 */
export const cleanupCourseContent = async (courseId: string): Promise<CleanupResult> => {
  // Grab insight ids first so we can cascade to UserInsightProgress before
  // deleting the insight rows themselves.
  const insightIdDocs = await InsightModel.find({ courseId }).select('_id').lean();
  const insightIds = insightIdDocs.map((d) => d._id);

  const [
    chatSessions,
    mentorChats,
    courseMentorChats,
    lessonContent,
    lessonProgress,
    quizContent,
    quizProgress,
    insights,
    insightProgress,
    ragCleanup,
  ] = await Promise.all([
    CourseDesignChatModel.deleteMany({ courseId }),
    LessonMentorChatModel.deleteMany({ courseId }),
    // CourseMentorChatModel was added after the original cleanup wiring
    // landed and was missing from the cascade — leaving rows orphaned on
    // course deletion. Caught by the audit; one-line fix.
    CourseMentorChatModel.deleteMany({ courseId }),
    LessonContentModel.deleteMany({ courseId }),
    UserLessonProgressModel.deleteMany({ courseId }),
    ModuleQuizContentModel.deleteMany({ courseId }),
    UserModuleQuizProgressModel.deleteMany({ courseId }),
    InsightModel.deleteMany({ courseId }),
    insightIds.length > 0
      ? UserInsightProgressModel.deleteMany({ insightId: { $in: insightIds } })
      : Promise.resolve({ deletedCount: 0 }),
    // RAG cleanup wraps Mongo + Pinecone deletions; failure logs but doesn't
    // abort the rest of the cleanup. Returning zero counts on error means
    // a future re-cleanup is harmless (idempotent).
    deleteLessonChunksForCourse(courseId).catch((e) => {
      bgError('courseCleanup.rag')(e);
      return { chunksDeleted: 0, vectorsDeleted: 0 };
    }),
  ]);

  // S3 cleanup (hero images, future assets) — fire and forget
  deleteByPrefix(`lessons/${courseId}/`)
    .then((count) => {
      if (count > 0) integrationLog.info(`s3:deletePrefix prefix=lessons/${courseId}/ deleted=${count}`);
    })
    .catch(bgError('courseCleanup.s3'));

  const result: CleanupResult = {
    chatSessionsDeleted: chatSessions.deletedCount,
    mentorChatsDeleted: mentorChats.deletedCount,
    courseMentorChatsDeleted: courseMentorChats.deletedCount,
    lessonContentDeleted: lessonContent.deletedCount,
    lessonProgressDeleted: lessonProgress.deletedCount,
    quizContentDeleted: quizContent.deletedCount,
    quizProgressDeleted: quizProgress.deletedCount,
    insightsDeleted: insights.deletedCount,
    insightProgressDeleted: insightProgress.deletedCount ?? 0,
    ragChunksDeleted: ragCleanup.chunksDeleted,
    ragVectorsDeleted: ragCleanup.vectorsDeleted,
  };

  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total > 0) {
    jobLog.info(
      `cleanup:course course=${courseId} total=${total} ` +
        `chats=${result.chatSessionsDeleted} mentor=${result.mentorChatsDeleted} ` +
        `lessons=${result.lessonContentDeleted} progress=${result.lessonProgressDeleted} ` +
        `quiz=${result.quizContentDeleted}/${result.quizProgressDeleted} ` +
        `insights=${result.insightsDeleted}/${result.insightProgressDeleted} ` +
        `rag=${result.ragChunksDeleted}/${result.ragVectorsDeleted}`,
    );
  }

  return result;
};

export interface EditImpactResult {
  hasContent: boolean;
  hasProgress: boolean;
  completedLessons: number;
  inProgressLessons: number;
  totalNotes: number;
  totalBookmarks: number;
  quizAttempts: number;
  modulesWithMastery: number;
  scheduledReviews: number;
  totalTimeSpentMinutes: number;
}

/**
 * Assesses the impact of editing a course — how much content and progress exists
 * that would be lost if the course structure changes.
 */
export const getEditImpact = async ({ courseId, userId }: { courseId: string; userId: string }): Promise<EditImpactResult> => {
  const [contentCount, quizContentCount, lessonProgressAgg, quizProgressAgg] = await Promise.all([
    LessonContentModel.countDocuments({ courseId }),
    ModuleQuizContentModel.countDocuments({ courseId }),
    UserLessonProgressModel.aggregate([
      { $match: { courseId, userId } },
      {
        $group: {
          _id: null,
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
          totalNotes: { $sum: { $cond: [{ $and: [{ $ne: ['$notes', null] }, { $ne: ['$notes', ''] }] }, 1, 0] } },
          totalBookmarks: { $sum: { $cond: ['$bookmarked', 1, 0] } },
          totalTimeSpent: { $sum: '$timeSpentSeconds' },
        },
      },
    ]),
    UserModuleQuizProgressModel.aggregate([
      { $match: { courseId, userId } },
      {
        $group: {
          _id: null,
          totalAttempts: { $sum: { $size: '$attempts' } },
          modulesWithMastery: {
            $sum: { $cond: [{ $in: ['$bestTier', ['passed', 'mastered']] }, 1, 0] },
          },
          scheduledReviews: {
            $sum: { $cond: [{ $ne: ['$nextReviewAt', null] }, 1, 0] },
          },
        },
      },
    ]),
  ]);

  const lp = lessonProgressAgg[0] ?? {};
  const qp = quizProgressAgg[0] ?? {};

  return {
    hasContent: contentCount > 0 || quizContentCount > 0,
    hasProgress: (lp.completed ?? 0) > 0 || (lp.inProgress ?? 0) > 0 || (qp.totalAttempts ?? 0) > 0,
    completedLessons: lp.completed ?? 0,
    inProgressLessons: lp.inProgress ?? 0,
    totalNotes: lp.totalNotes ?? 0,
    totalBookmarks: lp.totalBookmarks ?? 0,
    quizAttempts: qp.totalAttempts ?? 0,
    modulesWithMastery: qp.modulesWithMastery ?? 0,
    scheduledReviews: qp.scheduledReviews ?? 0,
    totalTimeSpentMinutes: Math.round((lp.totalTimeSpent ?? 0) / 60),
  };
};
