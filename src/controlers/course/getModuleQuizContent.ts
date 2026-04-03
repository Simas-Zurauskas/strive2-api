import asyncHandler from 'express-async-handler';
import { getUserCourse } from '@services/courseDbService';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import { parseIndexParam } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/module-quiz/{moduleIndex}:
 *   get:
 *     summary: Get module quiz content (correctIndex and explanation stripped for anti-cheat)
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
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 */
export const getModuleQuizContentController = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId as string;
  const userId = req.userId!;
  const moduleIndex = parseIndexParam(req.params.moduleIndex, 'moduleIndex');

  await getUserCourse({ userId, courseId });

  const quiz = await ModuleQuizContentModel.findOne({ courseId, moduleIndex }).lean();
  if (!quiz) {
    res.status(404).json({ message: 'Quiz not generated yet' });
    return;
  }

  // Strip correctIndex and explanation to prevent cheating
  const strippedQuestions = quiz.questions.map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options,
    sourceLessons: q.sourceLessons,
    isInterleaved: q.isInterleaved,
    interleavedModuleIndex: q.interleavedModuleIndex,
  }));

  res.status(200).json({
    data: {
      courseId: quiz.courseId,
      moduleIndex: quiz.moduleIndex,
      questions: strippedQuestions,
      version: quiz.version,
    },
  });
});
