import { Types } from 'mongoose';
import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import LessonContentModel from '@models/LessonContentModel';
import LessonMentorChatModel from '@models/LessonMentorChatModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';

const MAX_PROMPTS = 4;

/**
 * Compute the empty-state prompts for the mentor panel.
 *
 * Two ingredients only:
 *   1. ONE contextual prompt — fires only when chat is the *right*
 *      surface for the learner's current state. We deliberately do NOT
 *      fire one for "recall cards due" (the Recall queue is the right
 *      surface) or "lesson completed" (the Module Quiz is the right
 *      surface) — those would just route the learner into chat to do
 *      something a dedicated surface already does better. Low quiz
 *      score is different: only chat can unpack *why* a specific
 *      answer was wrong, so that one stays.
 *   2. Lesson-specific prompts from `LessonContent.suggestedMentorPrompts`,
 *      generated once at lesson-create time by `generateMentorPrompts`.
 *
 * Hardcoded fillers were removed. Legacy lessons that pre-date the
 * lesson-specific generator return an empty array — the panel shows
 * no prompt buttons, and the learner just types their own question.
 * Showing canned "Explain this concept differently"-style strings
 * actively cheapens the mentor: it signals the system has nothing
 * useful to say about *this* lesson.
 *
 * Caller MUST only invoke this with `lessonGenerated === true`. The
 * client renders a separate empty-state UI for ungenerated lessons.
 */
const computeSuggestedPrompts = ({
  lessonGenerated,
  quizBestScore,
  lessonSpecificPrompts,
}: {
  lessonGenerated: boolean;
  quizBestScore: number | null;
  /** From `LessonContent.suggestedMentorPrompts` — generated once at lesson-create time. */
  lessonSpecificPrompts: string[];
}): string[] => {
  if (!lessonGenerated) return [];

  // Single contextual prompt, only when chat is genuinely the right
  // surface (vs Recall / Module Quiz, which already cover their own
  // jobs).
  const contextualPrompt =
    quizBestScore !== null && quizBestScore < 70
      ? 'I scored low on the quiz — help me understand what I missed'
      : null;

  const combined: string[] = [];
  if (contextualPrompt) combined.push(contextualPrompt);
  combined.push(...lessonSpecificPrompts);
  return combined.slice(0, MAX_PROMPTS);
};

/**
 * @swagger
 * /api/course/{courseId}/lesson/{moduleIndex}/{lessonIndex}/mentor/chat/history:
 *   get:
 *     summary: Fetch the lesson-mentor chat session for a learner
 *     tags: [Course]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: moduleIndex
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: lessonIndex
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/LessonChatHistoryResponse'
 */
export const getLessonChatHistoryController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const moduleIndex = parseInt(req.params.moduleIndex as string, 10);
  const lessonIndex = parseInt(req.params.lessonIndex as string, 10);

  if (isNaN(moduleIndex) || isNaN(lessonIndex)) {
    res.status(400).json({ message: 'Invalid moduleIndex or lessonIndex' });
    return;
  }

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id;
  const userObjectId = new Types.ObjectId(userId);

  const [session, lessonContent, quizProgress] = await Promise.all([
    LessonMentorChatModel.findOne({
      courseId,
      userId,
      moduleIndex,
      lessonIndex,
    }).lean(),
    // `completed: true` means lesson generation finished AND passed the
    // persistence gate. Pre-generation = nothing here OR a row with
    // `completed: false` (in-progress / failed). Either way, treat as
    // not generated for prompt-mode purposes.
    LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex })
      .select('completed suggestedMentorPrompts')
      .lean(),
    UserModuleQuizProgressModel.findOne({ userId: userObjectId, courseId, moduleIndex })
      .select('bestScore')
      .lean(),
  ]);

  const lessonGenerated = lessonContent?.completed === true;

  const suggestedPrompts = computeSuggestedPrompts({
    lessonGenerated,
    quizBestScore: quizProgress?.bestScore ?? null,
    lessonSpecificPrompts: lessonContent?.suggestedMentorPrompts ?? [],
  });

  // Build the per-attachment metadata map for the client to render chips.
  // The full extracted text stays server-side — never sent to the client
  // (the cached system block is for the model only). The client just
  // needs filename + token count to render the chip.
  const attachmentsById: Record<
    string,
    { id: string; filename: string; kind: 'pdf' | 'text'; approxTokens: number }
  > = {};
  for (const a of session?.attachments ?? []) {
    attachmentsById[a.id] = {
      id: a.id,
      filename: a.filename,
      kind: a.kind,
      approxTokens: a.approxTokens,
    };
  }

  res.json({
    data: {
      messages: session?.messages ?? [],
      attachmentsById,
      suggestedPrompts,
      lessonGenerated,
    },
  });
});
