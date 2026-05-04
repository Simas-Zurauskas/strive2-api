import asyncHandler from 'express-async-handler';
import { getRecallStats, getRecallDueCount } from '@services/recallQueueService';

/**
 * @swagger
 * /api/recall/stats:
 *   get:
 *     summary: Get per-user recall review stats (mastery dashboard)
 *     tags:
 *       - Recall
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
 *                   $ref: '#/components/schemas/RecallStats'
 */
export const getRecallStatsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const stats = await getRecallStats({ userId });
  res.status(200).json({ data: stats });
});

/**
 * @swagger
 * /api/recall/due-count:
 *   get:
 *     summary: Cheap count of due recall cards for dashboard widgets
 *     tags:
 *       - Recall
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
export const getRecallDueCountController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const count = await getRecallDueCount({ userId });
  res.status(200).json({ data: { count } });
});
