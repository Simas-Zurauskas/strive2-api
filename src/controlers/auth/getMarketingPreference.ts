import asyncHandler from 'express-async-handler';
import UserModel from '@models/UserModel';
import { getPromotionalSubscribed } from '@services/mailjetContactService';

/**
 * @swagger
 * /api/auth/me/marketing-preference:
 *   get:
 *     summary: Get the authenticated user's promotional-email subscription state
 *     description: |
 *       Reads the user's subscription status on the Mailjet "promotional"
 *       contact list. The Mailjet record is the source of truth — clicks
 *       on the unsubscribe link in any promotional email also write to it,
 *       so this endpoint and the email-link path stay consistent without
 *       sync logic.
 *     tags:
 *       - Auth
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
 *                   required: [subscribed]
 *                   properties:
 *                     subscribed:
 *                       type: boolean
 */
export const getMarketingPreferenceController = asyncHandler(async (req, res) => {
  const user = await UserModel.findById(req.userId).select('email').lean();
  if (!user) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  const subscribed = await getPromotionalSubscribed(user.email);
  res.status(200).json({ data: { subscribed } });
});
