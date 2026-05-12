import asyncHandler from 'express-async-handler';
import { PLANS, PLAN_KEYS, PRICING_CONFIG } from '@lib/creditPricing';

/**
 * @swagger
 * /api/billing/plans:
 *   get:
 *     summary: Public plan catalog (pricing, allowances, top-up rate, reference costs)
 *     description: >
 *       Returns everything the client needs to render the pricing page,
 *       the top-up widget, and every "≈ X lessons" approximation across
 *       the app. No auth required — the pricing page should be crawlable.
 *       Stripe price IDs are intentionally omitted; checkout is initiated
 *       by plan+cadence keys, which the server resolves server-side.
 *
 *       Per-action credit costs are not surfaced — user billing is
 *       real-cost metered (credits debited post-hoc from measured provider
 *       spend), so there are no flat per-action prices to publish. The
 *       `referenceCosts` block carries empirical median ranges used for
 *       UI approximations only.
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
        creditsPerUsd: PRICING_CONFIG.topup.creditsPerUsd,
        minUsd: PRICING_CONFIG.topup.minUsd,
        maxUsd: PRICING_CONFIG.topup.maxUsd,
        // Curated chip amounts — clients render these as the quick-pick
        // chips in TopupControl. Sourced from config so a knob change
        // cascades to the UI without a client deploy.
        quickPicks: [...PRICING_CONFIG.topup.quickPicks],
      },
      // Allowance shape: free unit + per-plan multipliers. Lets clients
      // render "10×", "22×", "48×" multiplier strings without hardcoding,
      // and recompute lessons/credits without round-tripping.
      allowance: {
        unit: PRICING_CONFIG.allowance.unit,
        multipliers: { ...PRICING_CONFIG.allowance.multipliers },
      },
      // Reference per-action credit ranges, measured from orchestrator
      // cohorts. Used purely for UI "≈ X lessons" approximations. NOT
      // a billing contract — actual debits are real-cost metered.
      referenceCosts: {
        lessonCredits: [...PRICING_CONFIG.referenceCosts.lessonCredits],
        // Top-up bonus credits pay 5× lesson markup vs allowance's 4×, so a
        // top-up dollar buys ~25% fewer lessons than the equivalent allowance
        // credits. Surfaced separately so the top-up control's "$X ≈ N lessons"
        // chips compute against the right rate — using `lessonCredits` here
        // overstates top-up generosity by ~25%.
        lessonCreditsTopup: [...PRICING_CONFIG.referenceCosts.lessonCreditsTopup],
        recallCardExtractionCredits: [...PRICING_CONFIG.referenceCosts.recallCardExtractionCredits],
        courseStructureCredits: [...PRICING_CONFIG.referenceCosts.courseStructureCredits],
        moduleQuizCredits: [...PRICING_CONFIG.referenceCosts.moduleQuizCredits],
        mentorTurnCredits: [...PRICING_CONFIG.referenceCosts.mentorTurnCredits],
        recallReviewCredits: [...PRICING_CONFIG.referenceCosts.recallReviewCredits],
      },
    },
  });
});
