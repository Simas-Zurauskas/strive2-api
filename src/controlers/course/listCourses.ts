import asyncHandler from 'express-async-handler';
import { listUserCourses, omitServerOnlyCourseFields } from '@services/courseDbService';

/**
 * @swagger
 * /api/course:
 *   get:
 *     summary: List all courses for the authenticated user
 *     tags:
 *       - Course
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
 *                     $ref: '#/components/schemas/Course'
 */
export const listCoursesController = asyncHandler(async (req, res) => {
  const courses = await listUserCourses({ userId: req.userId! });

  res.status(200).json({ data: courses.map(omitServerOnlyCourseFields) });
});
