import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import UserModel from '@models/UserModel';
import MarketingContactModel from '@models/MarketingContactModel';
import { MARKETING_EVIDENCE } from '@lib/constants';
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
 *       Writes the new state to our own `MarketingContact` ledger first —
 *       an opt-in recorded as `basis: consent`, an opt-out as a suppression
 *       — and only then mirrors it to the Mailjet "promotional" contact
 *       list. Ledger-first is deliberate: if the Mailjet call fails, the
 *       user's decision is already recorded on the side that decides the
 *       audience.
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

  // ── Local ledger FIRST, Mailjet second ──────────────────
  //
  // Fail-safe ordering. `setPromotionalSubscribed` throws on any Mailjet
  // error; if it ran first, a vendor blip would lose the user's decision
  // entirely. This way the worst case is a ledger that is momentarily
  // ahead of Mailjet, which the pre-campaign bulk suppression read and the
  // next toggle both reconcile.
  //
  // This is the ONLY path allowed to write `basis: 'consent'` (PLAN A2) —
  // it is the only one where a user affirmatively asked for marketing mail.
  // Opting out records the suppression but leaves the basis alone: there is
  // no such thing as "consent to stop".
  if (subscribed) {
    await MarketingContactModel.updateOne(
      { email: user.email },
      {
        $set: {
          userId: user._id,
          basis: 'consent',
          source: 'profile_toggle',
          evidence: MARKETING_EVIDENCE.PROFILE_TOGGLE,
          optedOut: false,
        },
        // Cleared, not left stale — a live consent with an opt-out
        // timestamp attached reads as a contradiction in an audit.
        // `$unset` rather than `$set: undefined`, which Mongoose strips.
        $unset: { optedOutAt: '' },
        $setOnInsert: { email: user.email },
      },
      { upsert: true },
    );
  } else {
    await MarketingContactModel.updateOne(
      { email: user.email },
      {
        $set: { userId: user._id, optedOut: true, optedOutAt: new Date() },
        $setOnInsert: {
          email: user.email,
          basis: 'soft_opt_in',
          source: 'profile_toggle',
          evidence: MARKETING_EVIDENCE.PROFILE_TOGGLE,
        },
      },
      { upsert: true },
    );
  }

  await setPromotionalSubscribed({ email: user.email, subscribed });
  res.status(200).json({ data: { subscribed } });
});
