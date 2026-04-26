import asyncHandler from 'express-async-handler';
import UserModel from '@models/UserModel';
import { PLANS } from '@lib/creditPricing';
import { getBalance } from '@services/creditService';

/**
 * @swagger
 * /api/billing/summary:
 *   get:
 *     summary: Current plan + credit balance + period info for the authenticated user
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
 *                   $ref: '#/components/schemas/BillingSummary'
 */
export const getBillingSummaryController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const balance = await getBalance(userId);
  // getBalance reads + reset; re-fetch subscription/allowanceGranted fields it
  // doesn't return (kept lean so the balance helper stays focused).
  const user = await UserModel.findById(userId).select('subscription credits.allowanceGranted').lean();
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  res.json({
    data: {
      plan: balance.plan,
      displayName: PLANS[balance.plan].displayName,
      status: user.subscription.status,
      cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
      pendingPlan: user.subscription.pendingPlan ?? null,
      credits: {
        allowance: balance.allowance,
        bonus: balance.bonus,
        total: balance.total,
        allowanceGranted: user.credits.allowanceGranted,
        periodStart: balance.periodStart,
        periodEnd: balance.periodEnd,
      },
    },
  });
});
