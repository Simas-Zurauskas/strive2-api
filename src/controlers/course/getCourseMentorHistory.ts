import { Types } from 'mongoose';
import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import LessonContentModel from '@models/LessonContentModel';
import CourseMentorChatModel from '@models/CourseMentorChatModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import UserRecallProgressModel from '@models/UserRecallProgressModel';
import RecallCardModel from '@models/RecallCardModel';

const MAX_PROMPTS = 3;
/** A "long gap" since last activity — triggers the refresh-me prompt. */
const LONG_GAP_DAYS = 7;

/**
 * Course-scoped suggested prompts.
 *
 * Distinct from the lesson mentor's prompt set: those are about THIS
 * lesson; these are about NEXT-MOVE decisions across the course. Strict
 * priority order, max three prompts shown:
 *
 *   1. Long gap since last activity → "Refresh me on what I've covered"
 *   2. Recall cards due across the course → "I have N recall cards due — where should I start?"
 *   3. A module is ripe for its quiz (all lessons complete, quiz not taken)
 *      → "Help me prep before the module M quiz"
 *   4. Mid-course (1+ completed, not all) → "Connect what I just learned to what's next"
 *   5. Cold start (zero progress) → orientation prompts (overview / goal /
 *      prereqs) — explicitly NOT navigation prompts because at cold start
 *      there's only one place to start, so "Where should I start?" isn't
 *      a real question.
 *   6. Always-on fallback → "I'm stuck somewhere — help me figure out where"
 *
 * Lesson-specific prompts (`LessonContent.suggestedMentorPrompts`) are
 * NOT used here — they're per-lesson. The course mentor only ships
 * state-derived prompts.
 */
const computeCourseSuggestedPrompts = ({
  courseGenerated,
  lessonsCompleted,
  totalLessons,
  daysSinceLastActivity,
  recallDue,
  ripeModule,
}: {
  courseGenerated: boolean;
  lessonsCompleted: number;
  totalLessons: number;
  daysSinceLastActivity: number | null;
  recallDue: number;
  /** Module index where all lessons are complete and the quiz hasn't been taken. */
  ripeModule: number | null;
}): string[] => {
  if (!courseGenerated) return [];

  const prompts: string[] = [];

  // Cold start: no progress yet. Three orientation prompts — overview /
  // goal-alignment / prereqs. We deliberately skip "Where should I start?"
  // because at cold start there is only one place to start (Module 1
  // Lesson 1), so it isn't a real question. The always-on fallback below
  // isn't appended here because it implies the learner has been working,
  // which they haven't.
  if (lessonsCompleted === 0) {
    return [
      "What's the arc of this course?",
      'How does this map to my goal?',
      'Anything I should brush up on first?',
    ];
  }

  // Returning after a gap: prioritize the refresh prompt.
  if (daysSinceLastActivity !== null && daysSinceLastActivity >= LONG_GAP_DAYS) {
    prompts.push("Refresh me on what I've covered");
  }

  if (recallDue > 0 && prompts.length < MAX_PROMPTS) {
    prompts.push(
      `I have ${recallDue} card${recallDue > 1 ? 's' : ''} due — where should I start?`,
    );
  }

  if (ripeModule !== null && prompts.length < MAX_PROMPTS) {
    prompts.push(`Help me prep before the module ${ripeModule + 1} quiz`);
  }

  if (
    lessonsCompleted > 0 &&
    lessonsCompleted < totalLessons &&
    prompts.length < MAX_PROMPTS
  ) {
    prompts.push('Connect what I just learned to what comes next');
  }

  // Always-on fallback — only if we have room.
  if (prompts.length < MAX_PROMPTS) {
    prompts.push("I'm stuck somewhere — help me figure out where");
  }

  return prompts.slice(0, MAX_PROMPTS);
};

/**
 * @swagger
 * /api/course/{courseId}/mentor/chat/history:
 *   get:
 *     summary: Fetch the course-mentor (compass) chat session for a learner
 *     tags: [Course]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/CourseMentorHistoryResponse'
 */
export const getCourseMentorHistoryController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id;
  const userObjectId = new Types.ObjectId(userId);

  const [session, lessonProgressRows, moduleQuizzes, anyLessonGenerated, recallCardIds] = await Promise.all([
    CourseMentorChatModel.findOne({ courseId, userId }).lean(),
    UserLessonProgressModel.find({ userId: userObjectId, courseId })
      .select('moduleIndex lessonIndex status completedAt')
      .lean(),
    UserModuleQuizProgressModel.find({ userId: userObjectId, courseId })
      .select('moduleIndex')
      .lean(),
    LessonContentModel.exists({ courseId, completed: true }),
    RecallCardModel.distinct('_id', { courseId }) as Promise<Types.ObjectId[]>,
  ]);

  const recallDue = recallCardIds.length > 0
    ? await UserRecallProgressModel.countDocuments({
        userId: userObjectId,
        recallCardId: { $in: recallCardIds },
        nextDue: { $lte: new Date() },
      })
    : 0;

  // A course is "generated" enough to chat with the mentor when the
  // structure exists AND it's been accepted (status='ready'). For
  // courses still in 'creating' status — the wizard hasn't finalized —
  // the chat is gated client-side; this flag is the server's signal.
  const hasStructure = !!course.structure?.modules?.length;
  const courseGenerated = hasStructure && course.status === 'ready';

  // Count lessons across all modules to drive the "mid-course" prompt
  // logic. Pulled from structure (titles exist for every lesson the
  // moment structure is generated) rather than from LessonContent
  // (which only has rows for generated lessons).
  const totalLessons = (course.structure?.modules ?? []).reduce(
    (sum, m) => sum + m.lessons.length,
    0,
  );
  const lessonsCompleted = lessonProgressRows.filter((l) => l.status === 'completed').length;

  // Compute days-since-last-activity from completedAt values.
  const lastActivity = lessonProgressRows
    .map((l) => l.completedAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const daysSinceLastActivity = lastActivity
    ? Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  // "Ripe module": all lessons in some module are completed AND the
  // module quiz hasn't been taken. Surface the lowest-numbered such
  // module so the prompt steers the learner to the earliest unfinished
  // checkpoint, not whichever happens to come first in the iteration.
  const completedKeys = new Set(
    lessonProgressRows
      .filter((l) => l.status === 'completed')
      .map((l) => `${l.moduleIndex}:${l.lessonIndex}`),
  );
  const quizTakenModules = new Set(moduleQuizzes.map((q) => q.moduleIndex));

  let ripeModule: number | null = null;
  for (let mi = 0; mi < (course.structure?.modules?.length ?? 0); mi += 1) {
    if (quizTakenModules.has(mi)) continue;
    const lessons = course.structure?.modules?.[mi]?.lessons ?? [];
    if (lessons.length === 0) continue;
    const allComplete = lessons.every((_, li) => completedKeys.has(`${mi}:${li}`));
    if (allComplete) {
      ripeModule = mi;
      break;
    }
  }

  const suggestedPrompts = computeCourseSuggestedPrompts({
    courseGenerated,
    lessonsCompleted,
    totalLessons,
    daysSinceLastActivity,
    recallDue,
    ripeModule,
  });

  res.json({
    data: {
      messages: session?.messages ?? [],
      suggestedPrompts,
      // The client uses this to decide whether to show the active chat
      // surface or a "course not ready" empty state.
      courseGenerated,
      // Surface this so the client can show "no lessons generated yet"
      // copy distinctly from "course not accepted yet".
      hasAnyLessonContent: !!anyLessonGenerated,
    },
  });
});
