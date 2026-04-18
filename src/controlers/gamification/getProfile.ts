import asyncHandler from 'express-async-handler';
import { getOrCreateProfile, computeLiveStreak, syncLiveStreak } from '@services/gamificationService';
import { xpForNextLevel } from '@lib/gamificationConstants';
import { bgError } from '@lib/bg';

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
  const liveStreak = computeLiveStreak(profile);

  // Sync stored streak + award any missed achievements if live value is higher
  if (liveStreak > profile.currentStreak) {
    syncLiveStreak({ userId, liveStreak }).catch(bgError('gamification.syncLiveStreak'));
  }

  res.status(200).json({
    data: {
      ...profile,
      currentStreak: liveStreak,
      xpForNextLevel: xpForNextLevel(profile.level),
    },
  });
});
