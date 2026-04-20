import asyncHandler from 'express-async-handler';
import { Types } from 'mongoose';
import { getInsightQueue } from '@services/insightQueueService';

/**
 * @swagger
 * /api/insight/queue:
 *   get:
 *     summary: Get the user's daily insight queue (due items + fresh items, interleaved across courses)
 *     description: |
 *       When `currentCourseId` is supplied (e.g. the learner is reviewing from
 *       inside a specific lesson) the active course's items are placed first
 *       in both the due and fresh slices; cross-course items still follow.
 *       Without the param the queue is a cross-course interleave as before.
 *     tags:
 *       - Insight
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: currentCourseId
 *         required: false
 *         description: Mongo ObjectId of the course the learner is currently studying. Items from this course are surfaced first.
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
 *                   $ref: '#/components/schemas/InsightQueue'
 *       400:
 *         description: Invalid currentCourseId (not an ObjectId).
 */
export const getInsightQueueController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  // `req.query` values can be strings, arrays, or parsed objects; only a
  // single string is meaningful here. Anything else is treated as absent.
  const raw = req.query.currentCourseId;
  const currentCourseIdParam = typeof raw === 'string' && raw.length > 0 ? raw : undefined;

  if (currentCourseIdParam && !Types.ObjectId.isValid(currentCourseIdParam)) {
    res.status(400);
    throw new Error('Invalid currentCourseId');
  }

  const queue = await getInsightQueue({ userId, currentCourseId: currentCourseIdParam });
  res.status(200).json({ data: queue });
});
