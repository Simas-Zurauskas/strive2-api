import asyncHandler from 'express-async-handler';
import { createTopupCheckout } from '@services/stripeService';
import { topupSchema } from './validation';

/**
 * @swagger
 * /api/billing/topup:
 *   post:
 *     summary: Start a variable-amount top-up Checkout session
 *     description: >
 *       User picks a whole-dollar USD amount between the rate's `minUsd` and
 *       `maxUsd` (exposed on `/api/billing/plans`). Credits granted on webhook
 *       receipt are `amountUsd × creditsPerUsd`, landing in the bonus balance
 *       (never expire, consumed after allowance).
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amountUsd]
 *             properties:
 *               amountUsd:
 *                 type: integer
 *                 description: Whole-dollar USD amount to top up.
 *                 minimum: 5
 *                 maximum: 500
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
export const startTopupController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { amountUsd } = topupSchema.parse(req.body);
  const session = await createTopupCheckout({ userId, amountUsd });
  if (!session.url) {
    res.status(500);
    throw new Error('Stripe returned a session without a redirect URL');
  }
  res.json({ data: { url: session.url } });
});
