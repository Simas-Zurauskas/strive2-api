import asyncHandler from 'express-async-handler';
import { scheduleSubscriptionCancellation } from '@services/stripeService';

/**
 * @swagger
 * /api/billing/cancel:
 *   post:
 *     summary: Cancel the active subscription at period end
 *     description: >
 *       User retains full access until the current billing period ends,
 *       then drops to Free. No refund (consistent with the no-voluntary-
 *       refunds policy in ToS). Does not cancel bonus credit packs — those
 *       are one-off purchases.
 *     tags: [Billing]
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
 *                   properties:
 *                     periodEnd:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 */
export const cancelSubscriptionController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const result = await scheduleSubscriptionCancellation({ userId });
  res.json({
    data: {
      periodEnd: result.periodEnd ? result.periodEnd.toISOString() : null,
    },
  });
});
