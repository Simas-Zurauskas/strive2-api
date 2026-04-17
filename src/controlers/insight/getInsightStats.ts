import asyncHandler from 'express-async-handler';
import { getInsightStats, getInsightsDueCount } from '@services/insightQueueService';

/**
 * @swagger
 * /api/insight/stats:
 *   get:
 *     summary: Get per-user insight review stats (mastery dashboard)
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
 *                   $ref: '#/components/schemas/InsightStats'
 */
export const getInsightStatsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const stats = await getInsightStats({ userId });
  res.status(200).json({ data: stats });
});

/**
 * @swagger
 * /api/insight/due-count:
 *   get:
 *     summary: Cheap count of due insights for dashboard widgets
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
 *                   type: object
 *                   required: [count]
 *                   properties:
 *                     count:
 *                       type: integer
 */
export const getInsightsDueCountController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const count = await getInsightsDueCount({ userId });
  res.status(200).json({ data: { count } });
});
