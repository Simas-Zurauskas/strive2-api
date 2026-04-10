import asyncHandler from 'express-async-handler';
import { getGamificationStats } from '@services/gamificationService';

/**
 * @swagger
 * /api/gamification/stats:
 *   get:
 *     summary: Get gamification stats (XP history, time learned, weekly lessons)
 *     tags:
 *       - Gamification
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
 *                   $ref: '#/components/schemas/GamificationStats'
 */
export const getStatsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const stats = await getGamificationStats(userId);

  res.status(200).json({ data: stats });
});
