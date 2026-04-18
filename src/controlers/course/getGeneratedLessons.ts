import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { getGeneratedLessons } from '@services/progressService';

/**
 * @swagger
 * /api/course/{courseId}/generated-lessons:
 *   get:
 *     summary: Get list of lessons that have generated content
 *     tags:
 *       - Progress
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
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
 *                     required: [moduleIndex, lessonIndex]
 *                     properties:
 *                       moduleIndex:
 *                         type: integer
 *                       lessonIndex:
 *                         type: integer
 */
export const getGeneratedLessonsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const generated = await getGeneratedLessons({ courseId });

  res.status(200).json({ data: generated });
});
