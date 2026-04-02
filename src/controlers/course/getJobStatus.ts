import asyncHandler from 'express-async-handler';
import JobModel from '@models/JobModel';

/**
 * @swagger
 * /api/course/job/{jobId}:
 *   get:
 *     summary: Get job status for polling
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
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
 *                   $ref: '#/components/schemas/JobStatus'
 */
export const getJobStatusController = asyncHandler(async (req, res) => {
  const jobId = req.params.jobId as string;
  const userId = req.userId!;

  const job = await JobModel.findById(jobId);

  if (!job) {
    res.status(404);
    throw new Error('Job not found');
  }

  if (job.userId.toString() !== userId) {
    res.status(403);
    throw new Error('Forbidden');
  }

  res.status(200).json({
    data: {
      status: job.status,
      type: job.type,
      error: job.error,
      courseId: job.courseId.toString(),
    },
  });
});
