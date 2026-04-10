import asyncHandler from 'express-async-handler';
import { getOrCreateProfile } from '@services/gamificationService';
import { xpForNextLevel } from '@lib/gamificationConstants';

/**
 * @swagger
 * /api/gamification/profile:
 *   get:
 *     summary: Get the user's gamification profile (XP, level, streak, achievements, settings)
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
 *                   $ref: '#/components/schemas/GamificationProfile'
 */
export const getProfileController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const profile = await getOrCreateProfile(userId);

  res.status(200).json({
    data: {
      ...profile,
      xpForNextLevel: xpForNextLevel(profile.level),
    },
  });
});
