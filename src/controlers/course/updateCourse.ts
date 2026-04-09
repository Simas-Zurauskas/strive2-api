import asyncHandler from 'express-async-handler';
import { updateCourseSchema } from './validation';
import { updateCourse, getUserCourse } from '@services/courseDbService';

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
 *                 $ref: '#/components/schemas/CourseDepth'
 *               status:
 *                 $ref: '#/components/schemas/CourseStatus'
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
 *       403:
 *         description: Cannot transition accepted course back to creating
 */
export const updateCourseController = asyncHandler(async (req, res) => {
  const updates = updateCourseSchema.parse(req.body);
  const userId = req.userId!;
  const resolved = await getUserCourse({ userId, courseId: req.params.id as string });
  const courseId = resolved._id.toString();

  // Guard: accepted courses cannot be moved back to creating status
  if (updates.status === 'creating') {
    if (resolved.status === 'ready') {
      res.status(403).json({ message: 'Cannot edit an accepted course. Course structure is locked once accepted.' });
      return;
    }
  }

  console.log(`[API] Update course: ${courseId} fields: ${Object.keys(updates).join(', ')}`.cyan);
  const course = await updateCourse({ userId, courseId, updates });
  console.log(`[API] Course updated: ${courseId}`.green);

  res.status(200).json({ data: course });
});
