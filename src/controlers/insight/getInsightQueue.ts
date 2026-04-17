import asyncHandler from 'express-async-handler';
import { getInsightQueue } from '@services/insightQueueService';

/**
 * @swagger
 * /api/insight/queue:
 *   get:
 *     summary: Get the user's daily insight queue (due items + fresh items, interleaved across courses)
 *     tags:
 *       - Insight
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
 *                   $ref: '#/components/schemas/InsightQueue'
 */
export const getInsightQueueController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const queue = await getInsightQueue({ userId });
  res.status(200).json({ data: queue });
});
