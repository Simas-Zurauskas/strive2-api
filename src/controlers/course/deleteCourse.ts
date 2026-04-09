import asyncHandler from 'express-async-handler';
import CourseModel from '@models/CourseModel';
import JobModel from '@models/JobModel';
import CourseDesignChatModel from '@models/CourseDesignChatModel';
import { cleanupCourseContent } from '@services/courseCleanupService';
import { getUserCourse } from '@services/courseDbService';

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
  const userId = req.userId!;
  const course = await getUserCourse({ userId, courseId: req.params.id as string });

  await Promise.all([
    JobModel.deleteMany({ courseId: course._id }),
    CourseDesignChatModel.deleteMany({ courseId: course._id }),
    cleanupCourseContent(course._id.toString()),
  ]);
  await CourseModel.findByIdAndDelete(course._id);

  console.log(`[API] Course deleted: ${course._id}`.green);

  res.status(200).json({ data: { deleted: true } });
});
