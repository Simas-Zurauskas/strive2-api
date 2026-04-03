import asyncHandler from 'express-async-handler';
import { getContinueLearning } from '@services/progressService';

/**
 * @swagger
 * /api/course/continue:
 *   get:
 *     summary: Get the most recently accessed lesson across all courses
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
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     courseId:
 *                       type: string
 *                     courseName:
 *                       type: string
 *                     courseGoal:
 *                       type: string
 *                     moduleName:
 *                       type: string
 *                     lessonName:
 *                       type: string
 *                     moduleIndex:
 *                       type: integer
 *                     lessonIndex:
 *                       type: integer
 *                     courseProgress:
 *                       $ref: '#/components/schemas/CourseProgressStats'
 */
export const getContinueLearningController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const result = await getContinueLearning({ userId });

  res.status(200).json({ data: result });
});
