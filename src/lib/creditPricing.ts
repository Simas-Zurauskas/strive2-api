// Pure data module — no env/process side effects so it's trivially testable.
// Stripe price-ID mapping is a separate concern (lives in stripeService).
//
// ──────────────────────────────────────────────────────────────────────
// Credit accounting model (real-cost metering)
// ──────────────────────────────────────────────────────────────────────
// User allowance is denominated in integer "credits". The credit unit is
// defined against real API cost via PRICING_CONFIG.microcentsPerCredit:
//
//     1 credit = MICROCENTS_PER_CREDIT microcents of raw provider spend
//               = $0.005 of Anthropic/BFL/Tavily/etc. cost (at 5,000 μ¢)
//
// User billing is deliberately DECOUPLED from a fixed per-action table.
// Instead, `jobRunner` calls `debitActualSpend` at successful job
// completion, which reads accumulated real spend from the current
// `usageContext` (summed by every `recordUsage` call during the job)
// and debits `ceil(microCents / MICROCENTS_PER_CREDIT)` credits from
// the user.
//
// The gate for starting a job is the middleware check "balance ≥ 1".
// Once the user has at least one credit they can launch any action; if
// the real cost exceeds what they had, we clamp the debit at the user's
// remaining balance and eat the difference. This is deliberate — a one-
// credit user finishing a generation that cost us slightly more is a
// rare, bounded loss that isn't worth the complexity of mid-job abort
// or over-draft accounting.
//
// Failed / canceled jobs debit nothing. Provider cost we incurred before
// the failure is written off the same way it was under the old flat-rate
// refund-on-failure model.
//
// ──────────────────────────────────────────────────────────────────────
// PRICING KNOBS LIVE IN pricingConfig.ts
// ──────────────────────────────────────────────────────────────────────
// This file re-exports the legacy flat constants for backwards compat
// (consumers from before the config refactor still import them by name).
// All actual values are sourced from PRICING_CONFIG — to change pricing,
// edit pricingConfig.ts, not here.

import {
  monthlyAllowanceFor,
  PLAN_KEYS,
  PlanKey,
  PRICING_CONFIG,
  topupUsdPerCredit,
  usdPerCreditFor,
} from './pricingConfig';

export {
  PLAN_KEYS,
  type PlanKey,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  PRICING_CONFIG,
  monthlyAllowanceFor,
  planMultiplier,
  usdPerCreditFor,
  topupUsdPerCredit,
  lessonRangeFromCredits,
  lessonRangeFromUsd,
  savingsVsTopupFor,
  maxSavingsVsTopup,
} from './pricingConfig';

export interface PlanDefinition {
  key: PlanKey;
  displayName: string;
  /**
   * Public-facing one-paragraph blurb shown on the /pricing page card and
   * mirrored in the matching Stripe product's `description`. Phrased in
   * usage-shape terms (courses, lessons, regenerations) rather than naked
   * credit numbers — credits are an internal accounting unit, not a UX one.
   * Update both this string and the Stripe product description together so
   * the pricing page and Checkout copy stay in lockstep.
   */
  description: string;
  /** Public monthly USD price, surfaced on pricing page. 0 for free. */
  monthlyUsd: number;
  /** Public annual USD price (monthly-equivalent), for the –20% annual plan. */
  annualMonthlyUsd: number;
  monthlyAllowance: number;
  maxConcurrentJobs: number;
}

// Every plan grants FULL feature access. The sole per-plan differentiator
// is `monthlyAllowance` (and its $ price) plus `maxConcurrentJobs`. Users
// pay by consumption, not by what they're allowed to do.
const MAX_CONCURRENT_JOBS = 3;

// Editorial blurbs for the Stripe product description / pricing card.
// Not derived from PRICING_CONFIG because they're marketing copy, not
// numeric. Update alongside the Stripe product descriptions.
//
// Cut to one or two sentences at review: the previous versions ran to
// three clauses each and, set in a pricing card, read as a paragraph the
// visitor had to work through rather than a line they could scan. Each now
// says who the plan is for and what its allowance affords — nothing else.
// Allowance is spoken of in courses and lessons; the word "credits" never
// appears in customer-facing copy.
const PLAN_DESCRIPTIONS: Record<PlanKey, string> = {
  free:
    'Try Strive end to end at no cost. A small monthly allowance for course building, lessons, quizzes and code practice.',
  starter:
    'For occasional learners. A monthly allowance sized for a few courses, with lessons, quizzes and code practice throughout.',
  pro:
    'For active learners. A substantially larger monthly allowance, with headroom for ongoing course building and frequent lesson regeneration.',
  studio:
    'For power users and educators. Our largest monthly allowance, for building several courses in parallel and heavy continuous use.',
};

const PLAN_DISPLAY_NAMES: Record<PlanKey, string> = {
  free:    'Free',
  starter: 'Starter',
  pro:     'Pro',
  studio:  'Studio',
};

/** Plan definitions derived from PRICING_CONFIG. Same shape as before the
 *  refactor — consumers that import PLANS directly continue to work. */
export const PLANS: Record<PlanKey, PlanDefinition> = Object.fromEntries(
  PLAN_KEYS.map((key) => [
    key,
    {
      key,
      displayName: PLAN_DISPLAY_NAMES[key],
      description: PLAN_DESCRIPTIONS[key],
      monthlyUsd: PRICING_CONFIG.planPricing[key].monthlyUsd,
      annualMonthlyUsd: PRICING_CONFIG.planPricing[key].annualMonthlyUsd,
      monthlyAllowance: monthlyAllowanceFor(key),
      maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    } satisfies PlanDefinition,
  ]),
) as Record<PlanKey, PlanDefinition>;

export const FREE_PERIOD_DAYS = PRICING_CONFIG.freePeriodDays;

// ──────────────────────────────────────────────────────────────────────
// Legacy flat constants (kept for backwards-compat with existing callers)
// ──────────────────────────────────────────────────────────────────────

export const MICROCENTS_PER_CREDIT = PRICING_CONFIG.microcentsPerCredit;

/**
 * Convert real provider cost (microcents) into user-billable credits.
 * Ceil so any non-zero spend charges at least 1 credit — never round a
 * paid API call down to zero, that's a free-ride bug. Negative / NaN
 * inputs yield 0 (defensive — a vendor row that came in with garbage
 * shouldn't corrupt the user's balance).
 */
export const microCentsToCredits = (microCents: number): number => {
  if (!Number.isFinite(microCents) || microCents <= 0) return 0;
  return Math.ceil(microCents / MICROCENTS_PER_CREDIT);
};

// User-facing $/credit by funding source. Derived from PRICING_CONFIG so
// any monthlyUsd / multiplier change cascades automatically. Used by the
// engineer billing view to translate per-row credits into the dollars
// the user effectively paid given which balance bucket covered them.
export const PLAN_USD_PER_CREDIT: Record<PlanKey, number> = Object.fromEntries(
  PLAN_KEYS.map((key) => [key, usdPerCreditFor(key)]),
) as Record<PlanKey, number>;

export const TOPUP_CREDITS_PER_USD = PRICING_CONFIG.topup.creditsPerUsd;
export const TOPUP_USD_PER_CREDIT = topupUsdPerCredit();
export const TOPUP_MIN_USD = PRICING_CONFIG.topup.minUsd;
export const TOPUP_MAX_USD = PRICING_CONFIG.topup.maxUsd;
