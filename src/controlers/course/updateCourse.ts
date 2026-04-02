import asyncHandler from 'express-async-handler';
import { updateCourseSchema } from './validation';
import { updateCourse } from '@services/courseDbService';

/**
 * @swagger
 * /api/course/{id}:
 *   patch:
 *     summary: Update a course by ID
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               goal:
 *                 type: string
 *               answers:
 *                 type: object
 *               depth:
 *                 type: string
 *                 enum: [overview, comprehensive, deep_dive]
 *               status:
 *                 type: string
 *                 enum: [creating, ready, archived]
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
export const updateCourseController = asyncHandler(async (req, res) => {
  const updates = updateCourseSchema.parse(req.body);
  const courseId = req.params.id as string;

  console.log(`[API] Update course: ${courseId} fields: ${Object.keys(updates).join(', ')}`.cyan);
  const course = await updateCourse({ userId: req.userId!, courseId, updates });
  console.log(`[API] Course updated: ${courseId}`.green);

  res.status(200).json({ data: course });
});
