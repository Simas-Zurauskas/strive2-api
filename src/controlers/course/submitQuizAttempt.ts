import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { submitQuizAttempt } from '@services/quizProgressService';
import { submitQuizAttemptSchema, parseIndexParam } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/module-quiz/{moduleIndex}/submit:
 *   post:
 *     summary: Submit quiz attempt — grades answers and returns results with explanations
 *     tags:
 *       - ModuleQuiz
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: moduleIndex
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [responses]
 *             properties:
 *               responses:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [questionId, selectedOption]
 *                   properties:
 *                     questionId:
 *                       type: string
 *                     selectedOption:
 *                       type: integer
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/QuizAttemptResult'
 */
export const submitQuizAttemptController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const body = submitQuizAttemptSchema.parse(req.body);

  const { attempt, nextReviewAt, reviewIntervalDays, quiz } = await submitQuizAttempt({
    userId,
    courseId,
    moduleIndex,
    responses: body.responses,
  });

  const questionsWithFeedback = quiz.questions.map((q) => {
    const response = attempt.responses.find((r) => r.questionId === q.id);
    return {
      id: q.id,
      question: q.question,
      options: q.options,
      correctIndex: q.correctIndex,
      explanation: q.explanation,
      sourceLessons: q.sourceLessons,
      isInterleaved: q.isInterleaved,
      interleavedModuleIndex: q.interleavedModuleIndex,
      selectedOption: response?.selectedOption ?? null,
      correct: response?.correct ?? false,
    };
  });

  res.status(200).json({
    data: {
      attemptNumber: attempt.attemptNumber,
      score: attempt.score,
      masteryTier: attempt.masteryTier,
      completedAt: attempt.completedAt,
      questions: questionsWithFeedback,
      nextReviewAt: nextReviewAt.toISOString(),
      reviewIntervalDays,
    },
  });
});
