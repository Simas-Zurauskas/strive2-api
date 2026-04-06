import asyncHandler from 'express-async-handler';
import CourseModel from '@models/CourseModel';
import JobModel from '@models/JobModel';
import CourseDesignChatModel from '@models/CourseDesignChatModel';
import { cleanupCourseContent } from '@services/courseCleanupService';

/**
 * @swagger
 * /api/course/{id}:
 *   delete:
 *     summary: Delete a course and its associated jobs
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
 *                   type: object
 *                   required: [deleted]
 *                   properties:
 *                     deleted:
 *                       type: boolean
 */
export const deleteCourseController = asyncHandler(async (req, res) => {
  const courseId = req.params.id as string;
  const userId = req.userId!;

  const course = await CourseModel.findById(courseId);

  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }

  if (course.userId.toString() !== userId) {
    res.status(403);
    throw new Error('Forbidden');
  }

  await Promise.all([
    JobModel.deleteMany({ courseId: course._id }),
    CourseDesignChatModel.deleteMany({ courseId: course._id }),
    cleanupCourseContent(courseId),
  ]);
  await CourseModel.findByIdAndDelete(courseId);

  console.log(`[API] Course deleted: ${courseId}`.green);

  res.status(200).json({ data: { deleted: true } });
});
