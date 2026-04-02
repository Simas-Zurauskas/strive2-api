import asyncHandler from 'express-async-handler';
import { getUserCourse } from '@services/courseDbService';

/**
 * @swagger
 * /api/course/{id}:
 *   get:
 *     summary: Get a single course by ID
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *                   $ref: '#/components/schemas/Course'
 */
export const getCourseController = asyncHandler(async (req, res) => {
  const course = await getUserCourse({ userId: req.userId!, courseId: req.params.id as string });

  res.status(200).json({ data: course });
});
