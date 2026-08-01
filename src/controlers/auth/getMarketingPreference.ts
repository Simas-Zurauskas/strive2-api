import asyncHandler from 'express-async-handler';
import UserModel from '@models/UserModel';
import MarketingContactModel from '@models/MarketingContactModel';
import { getPromotionalSubscribed } from '@services/mailjetContactService';

/**
 * @swagger
 * /api/auth/me/marketing-preference:
 *   get:
 *     summary: Get the authenticated user's promotional-email subscription state
 *     description: |
 *       Returns false immediately if our own `MarketingContact` ledger
 *       records a suppression for this address — the ledger is what decides
 *       whether a send happens, so it cannot be contradicted by a vendor
 *       read. Otherwise falls through to the Mailjet "promotional" list,
 *       which still receives unsubscribes from its own hosted page.
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

  // Local suppression wins, and short-circuits the Mailjet round trip.
  //
  // Our unsubscribe route writes the ledger first and pushes to Mailjet
  // fail-soft, so there is a window in which the ledger says "opted out"
  // and Mailjet still says "subscribed". Reading Mailjet alone would render
  // the toggle CHECKED for someone who just unsubscribed — and, worse,
  // invite them to "fix" it by toggling, which is a real re-subscribe.
  // Asymmetric on purpose: the ledger can only ever make the answer more
  // negative, never flip a genuine opt-out back to opted-in.
  const contact = await MarketingContactModel.findOne({ email: user.email })
    .select('optedOut')
    .lean();
  if (contact?.optedOut) {
    res.status(200).json({ data: { subscribed: false } });
    return;
  }

  const subscribed = await getPromotionalSubscribed(user.email);
  res.status(200).json({ data: { subscribed } });
});
