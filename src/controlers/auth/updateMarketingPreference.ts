import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import UserModel from '@models/UserModel';
import { setPromotionalSubscribed } from '@services/mailjetContactService';

const bodySchema = z.object({
  subscribed: z.boolean(),
});

/**
 * @swagger
 * /api/auth/me/marketing-preference:
 *   patch:
 *     summary: Toggle the authenticated user's promotional-email subscription
 *     description: |
 *       Writes the new state to the user's record on the Mailjet
 *       "promotional" contact list. `true` upserts the contact and clears
 *       the unsubscribe flag; `false` flags it unsubscribed (matching what
 *       the email-link unsubscribe does on Mailjet's hosted page).
 *     tags:
 *       - Auth
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subscribed]
 *             properties:
 *               subscribed:
 *                 type: boolean
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
export const updateMarketingPreferenceController = asyncHandler(async (req, res) => {
  const { subscribed } = bodySchema.parse(req.body);
  const user = await UserModel.findById(req.userId).select('email').lean();
  if (!user) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  await setPromotionalSubscribed({ email: user.email, subscribed });
  res.status(200).json({ data: { subscribed } });
});
