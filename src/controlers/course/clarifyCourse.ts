import asyncHandler from 'express-async-handler';
import { submitJob } from '@services/jobRunner';
import { getUserCourse } from '@services/courseDbService';

/**
 * @swagger
 * /api/course/{courseId}/clarify:
 *   post:
 *     summary: Generate clarifying questions for a course
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       202:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 *                   required: [jobId]
 *                   properties:
 *                     jobId:
 *                       type: string
 */
export const clarifyCourseController = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId as string;
  const userId = req.userId!;

  await getUserCourse({ userId, courseId });

  console.log(`[API] Submitting clarify job, courseId: ${courseId}`.cyan);
  const jobId = await submitJob({
    userId,
    courseId,
    type: 'clarify',
  });
  console.log(`[API] Clarify job submitted: ${jobId}`.green);

  res.status(202).json({ data: { jobId } });
});
