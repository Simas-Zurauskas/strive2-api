import asyncHandler from 'express-async-handler';
import { submitJob } from '@services/jobRunner';
import { getUserCourseLean } from '@services/courseDbService';

/**
 * @swagger
 * /api/course/{courseId}/depth-previews:
 *   post:
 *     summary: Generate personalized depth level previews
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
export const generateDepthPreviewsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  console.log(`[API] Submitting depth previews job, courseId: ${courseId}`.cyan);
  const jobId = await submitJob({
    userId,
    courseId,
    type: 'generate_depth_previews',
  });
  console.log(`[API] Depth previews job submitted: ${jobId}`.green);

  res.status(202).json({ data: { jobId } });
});
