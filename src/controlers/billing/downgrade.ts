import asyncHandler from 'express-async-handler';
import { scheduleSubscriptionDowngrade } from '@services/stripeService';
import { downgradeSchema } from './validation';

/**
 * @swagger
 * /api/billing/downgrade:
 *   post:
 *     summary: Schedule a plan downgrade at current-period end (no charge today)
 *     description: >
 *       The user keeps their current (higher) plan until the billing period
 *       ends, then switches to the target plan on renewal. No proration
 *       charge is issued. Target must be strictly lower than the current
 *       plan; downgrading to Free is handled by `/api/billing/cancel`.
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
 *                 enum: [starter, pro]
 *                 description: Downgrade target — must be strictly lower than the current plan. Excludes studio (top tier) and free (handled via cancel).
 *               cadence:
 *                 $ref: '#/components/schemas/BillingCadence'
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
 *                   required: [scheduledPlan]
 *                   properties:
 *                     scheduledPlan:
 *                       $ref: '#/components/schemas/PlanKey'
 *                     periodEnd:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 */
export const downgradeController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { plan, cadence } = downgradeSchema.parse(req.body);
  const result = await scheduleSubscriptionDowngrade({ userId, plan, cadence });
  res.json({
    data: {
      scheduledPlan: result.scheduledPlan,
      periodEnd: result.periodEnd ? result.periodEnd.toISOString() : null,
    },
  });
});
