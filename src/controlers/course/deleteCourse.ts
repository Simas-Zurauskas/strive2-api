import asyncHandler from 'express-async-handler';
import CourseModel from '@models/CourseModel';
import JobModel from '@models/JobModel';

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

  await JobModel.deleteMany({ courseId: course._id });
  await CourseModel.findByIdAndDelete(courseId);

  console.log(`[API] Course deleted: ${courseId}`.green);

  res.status(200).json({ data: { deleted: true } });
});
