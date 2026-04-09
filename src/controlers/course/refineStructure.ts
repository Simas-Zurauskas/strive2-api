import asyncHandler from 'express-async-handler';
import { refineStructureSchema } from './validation';
import { submitJob } from '@services/jobRunner';
import { getUserCourse } from '@services/courseDbService';
import CourseModel from '@models/CourseModel';

/**
 * @swagger
 * /api/course/{courseId}/refine-structure:
 *   post:
 *     summary: Refine course structure based on learner feedback
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [feedback]
 *             properties:
 *               feedback:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 1000
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
export const refineStructureController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const parsed = refineStructureSchema.parse(req.body);
  const course = await getUserCourse({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  console.log(`[API] Submitting refine structure job, courseId: ${courseId} feedback: ${parsed.feedback}`.cyan);

  await CourseModel.findByIdAndUpdate(courseId, { pendingFeedback: parsed.feedback });

  const jobId = await submitJob({
    userId,
    courseId,
    type: 'refine_structure',
  });
  console.log(`[API] Refine structure job submitted: ${jobId}`.green);

  res.status(202).json({ data: { jobId } });
});
