import asyncHandler from 'express-async-handler';
import { getProgressSummary } from '@services/progressService';

/**
 * @swagger
 * /api/course/progress-summary:
 *   get:
 *     summary: Get progress percentage for all user courses
 *     tags:
 *       - Progress
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
 *                     type: object
 *                     required: [courseId, total, completed, percentage]
 *                     properties:
 *                       courseId:
 *                         type: string
 *                       total:
 *                         type: integer
 *                       completed:
 *                         type: integer
 *                       percentage:
 *                         type: integer
 */
export const getProgressSummaryController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const summary = await getProgressSummary({ userId });

  res.status(200).json({ data: summary });
});
