import asyncHandler from 'express-async-handler';
import { getUnattemptedQuizzes } from '@services/reviewSchedulingService';

/**
 * @swagger
 * /api/course/unattempted-quiz-count:
 *   get:
 *     summary: Get module quizzes never attempted across all courses (where module lessons are complete)
 *     tags:
 *       - Progress
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [courseId, courseName, moduleIndex, moduleName]
 *                     properties:
 *                       courseId:
 *                         type: string
 *                       courseSlug:
 *                         type: string
 *                         nullable: true
 *                       courseName:
 *                         type: string
 *                       moduleIndex:
 *                         type: number
 *                       moduleName:
 *                         type: string
 */
export const getUnattemptedQuizCountController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const items = await getUnattemptedQuizzes({ userId });

  res.status(200).json({ data: items });
});
