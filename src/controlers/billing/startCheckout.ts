import asyncHandler from 'express-async-handler';
import { createSubscriptionCheckout } from '@services/stripeService';
import { checkoutSchema } from './validation';

/**
 * @swagger
 * /api/billing/checkout:
 *   post:
 *     summary: Start a subscription Checkout session
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plan, cadence]
 *             properties:
 *               plan:
 *                 type: string
 *                 enum: [starter, pro, studio]
 *                 description: Paid plan to subscribe to — free is excluded (handled via cancel).
 *               cadence:
 *                 $ref: '#/components/schemas/BillingCadence'
 *               replaceCurrentSubscription:
 *                 type: boolean
 *                 description: >
 *                   Set true when the caller already has an active paid
 *                   subscription and is intentionally replacing it. The
 *                   server skips the duplicate-subscription guard and the
 *                   webhook cancels the old sub on checkout success.
 *                 default: false
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
 *                   required: [url]
 *                   properties:
 *                     url:
 *                       type: string
 */
export const startCheckoutController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { plan, cadence, replaceCurrentSubscription } = checkoutSchema.parse(req.body);
  const session = await createSubscriptionCheckout({ userId, plan, cadence, replaceCurrentSubscription });
  if (!session.url) {
    res.status(500);
    throw new Error('Stripe returned a session without a redirect URL');
  }
  res.json({ data: { url: session.url } });
});
