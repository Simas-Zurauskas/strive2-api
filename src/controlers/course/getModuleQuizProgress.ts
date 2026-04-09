import asyncHandler from 'express-async-handler';
import { getUserCourse } from '@services/courseDbService';
import { getModuleQuizProgress } from '@services/progressService';
import { parseIndexParam } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/module-quiz/{moduleIndex}/progress:
 *   get:
 *     summary: Get quiz progress (attempts, best score, mastery tier)
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
 *                   nullable: true
 *                   allOf:
 *                     - $ref: '#/components/schemas/UserModuleQuizProgress'
 */
export const getModuleQuizProgressController = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId as string;
  const userId = req.userId!;
  const moduleIndex = parseIndexParam(req.params.moduleIndex, 'moduleIndex');

  await getUserCourse({ userId, courseId });

  const progress = await getModuleQuizProgress({ userId, courseId, moduleIndex });

  res.status(200).json({ data: progress });
});
