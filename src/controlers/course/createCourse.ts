import asyncHandler from 'express-async-handler';
import { createCourseSchema } from './validation';
import { createCourse } from '@services/courseDbService';

/**
 * @swagger
 * /api/course:
 *   post:
 *     summary: Create a new course
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [goal]
 *             properties:
 *               goal:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 500
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
 *                   required: [courseId]
 *                   properties:
 *                     courseId:
 *                       type: string
 */
export const createCourseController = asyncHandler(async (req, res) => {
  const { goal } = createCourseSchema.parse(req.body);

  console.log(`[API] Creating course for user: ${req.userId} goal: ${goal}`.cyan);
  const course = await createCourse({ userId: req.userId!, goal });
  console.log(`[API] Course created: ${course._id.toString()}`.green);

  res.status(200).json({ data: { courseId: course._id.toString() } });
});
