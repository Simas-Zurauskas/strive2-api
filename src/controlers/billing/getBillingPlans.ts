import asyncHandler from 'express-async-handler';
import {
  PLANS,
  PLAN_KEYS,
  TOPUP_CREDITS_PER_USD,
  TOPUP_MAX_USD,
  TOPUP_MIN_USD,
} from '@lib/creditPricing';

/**
 * @swagger
 * /api/billing/plans:
 *   get:
 *     summary: Public plan catalog (pricing, allowances, top-up rate)
 *     description: >
 *       Returns everything the client needs to render the pricing page and
 *       the top-up widget. No auth required — the pricing page should be
 *       crawlable. Stripe price IDs are intentionally omitted; checkout is
 *       initiated by plan+cadence keys, which the server resolves
 *       server-side.
 *
 *       Per-action credit costs are no longer surfaced — user billing is
 *       real-cost metered (credits debited post-hoc from measured provider
 *       spend), so there are no flat per-action prices to publish.
 *     tags: [Billing]
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/BillingCatalog'
 */
export const getBillingPlansController = asyncHandler(async (_req, res) => {
  const plans = PLAN_KEYS.map((key) => {
    const plan = PLANS[key];
    return {
      key: plan.key,
      displayName: plan.displayName,
      description: plan.description,
      monthlyUsd: plan.monthlyUsd,
      annualMonthlyUsd: plan.annualMonthlyUsd,
      // Annual sticker = monthly-equiv × 12 (billed once/year). Clients can
      // recompute but surfacing it saves an mul+round at render time and
      // keeps the displayed total pinned to what Stripe actually charges.
      annualUsd: Number((plan.annualMonthlyUsd * 12).toFixed(2)),
      monthlyAllowance: plan.monthlyAllowance,
      maxConcurrentJobs: plan.maxConcurrentJobs,
    };
  });

  res.json({
    data: {
      plans,
      topupRate: {
        creditsPerUsd: TOPUP_CREDITS_PER_USD,
        minUsd: TOPUP_MIN_USD,
        maxUsd: TOPUP_MAX_USD,
      },
    },
  });
});
