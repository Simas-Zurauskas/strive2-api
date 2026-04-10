import asyncHandler from 'express-async-handler';
import { useStreakFreeze } from '@services/gamificationService';

/**
 * @swagger
 * /api/gamification/streak-freeze:
 *   post:
 *     summary: Manually use a streak freeze
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
 *                   type: object
 *                   required: [success, freezesRemaining]
 *                   properties:
 *                     success:
 *                       type: boolean
 *                     freezesRemaining:
 *                       type: integer
 */
export const useStreakFreezeController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const result = await useStreakFreeze(userId);

  res.status(200).json({ data: result });
});
