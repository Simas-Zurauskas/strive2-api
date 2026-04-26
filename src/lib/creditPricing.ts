// Pure data module — no env/process side effects so it's trivially testable.
// Stripe price-ID mapping is a separate concern (lives in stripeService).
//
// ──────────────────────────────────────────────────────────────────────
// Credit accounting model (real-cost metering)
// ──────────────────────────────────────────────────────────────────────
// User allowance is denominated in integer "credits". The credit unit is
// defined against real API cost:
//
//     1 credit = MICROCENTS_PER_CREDIT microcents of raw provider spend
//               = $0.005 of Anthropic/BFL/Tavily/etc. cost
//
// User billing is deliberately DECOUPLED from the fixed per-action table
// that used to live here. Instead, `jobRunner` calls `debitActualSpend`
// at successful job completion, which reads the accumulated real spend
// from the current `usageContext` (summed by every `recordUsage` call
// during the job) and debits `ceil(microCents / MICROCENTS_PER_CREDIT)`
// credits from the user.
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

export const PLAN_KEYS = ['free', 'starter', 'pro', 'studio'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'past_due', 'canceling', 'canceled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

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
// is `monthlyAllowance` (and its $ price) plus `maxConcurrentJobs`. Users pay
// by consumption, not by what they're allowed to do.
const UNIVERSAL_FEATURES = {
  maxConcurrentJobs: 3,
} as const;

// Allowance is surfaced to users as integer multiples of the Free grant
// (1×, 5×, 15×, 40×). Keep every `monthlyAllowance` an exact multiple of
// `PLANS.free.monthlyAllowance` so the pricing page never displays "~5×" —
// the client's `CREDITS_PER_ALLOWANCE` constant (currently 130) MUST match
// `PLANS.free.monthlyAllowance` here.
const ALLOWANCE_UNIT = 130;

export const PLANS: Record<PlanKey, PlanDefinition> = {
  free: {
    key: 'free',
    displayName: 'Free',
    description:
      'Get started at no cost. A modest recurring AI-generation allowance to try personalized course building, lesson generation, quizzes, and code-execution practice.',
    monthlyUsd: 0,
    annualMonthlyUsd: 0,
    monthlyAllowance: ALLOWANCE_UNIT * 1,
    ...UNIVERSAL_FEATURES,
  },
  starter: {
    key: 'starter',
    displayName: 'Starter',
    description:
      'Monthly plan for occasional learners. Recurring AI-generation allowance sized for building a few personalized courses each month, plus regular lesson generation, quizzes, and code-execution practice.',
    monthlyUsd: 12.99,
    annualMonthlyUsd: 10.39,
    monthlyAllowance: ALLOWANCE_UNIT * 5,
    ...UNIVERSAL_FEATURES,
  },
  pro: {
    key: 'pro',
    displayName: 'Pro',
    description:
      'Monthly plan for active learners. Substantially larger recurring AI-generation allowance — comfortable headroom for ongoing course building, frequent lesson regeneration, and intensive review and code practice.',
    monthlyUsd: 24.99,
    annualMonthlyUsd: 19.99,
    monthlyAllowance: ALLOWANCE_UNIT * 15,
    ...UNIVERSAL_FEATURES,
  },
  studio: {
    key: 'studio',
    displayName: 'Studio',
    description:
      'Monthly plan for power users and educators. Our largest recurring AI-generation allowance, designed for heavy continuous use — building several courses in parallel and frequent re-generation across the platform.',
    monthlyUsd: 49.99,
    annualMonthlyUsd: 39.99,
    monthlyAllowance: ALLOWANCE_UNIT * 40,
    ...UNIVERSAL_FEATURES,
  },
};

export const FREE_PERIOD_DAYS = 30;

// ──────────────────────────────────────────────────────────────────────
// Real-cost ↔ credits conversion (central knob — change ratios here)
// ──────────────────────────────────────────────────────────────────────
//
// 1 credit == MICROCENTS_PER_CREDIT microcents of raw provider spend.
// At 5,000 μ¢ the user pays:
//
//   Starter $12.99 / 650 credits = $0.01998/credit (~3.0× raw cost)
//   Pro     $24.99 / 1,950       = $0.01281/credit (~2.6× raw cost)
//   Studio  $49.99 / 5,200       = $0.00962/credit (~1.9× raw cost)
//
// Gross margin ladder per plan (user $ ÷ raw API budget):
//   Free     $0.00 / $0.65/mo     = loss leader
//   Starter  $12.99 / $3.25/mo    = 75%
//   Pro      $24.99 / $9.75/mo    = 61%
//   Studio   $49.99 / $26.00/mo   = 48%
//
// Top-ups are priced at $0.025/credit (= 25% above Starter's per-credit
// rate), calibrated in TOPUP_CREDITS_PER_USD below.
export const MICROCENTS_PER_CREDIT = 5_000;

/**
 * Convert real provider cost (microcents) into user-billable credits.
 * Ceil so any non-zero spend charges at least 1 credit — never round a
 * paid API call down to zero, that's a free-ride bug. Negative / NaN
 * inputs yield 0 (defensive — a vendor row that came in with garbage
 * shouldn't corrupt the user's balance).
 */

// The three user-facing prices per credit (set by the ratios we picked):
// Source	$/credit	Markup over real cost
// Subscription — Starter	$0.0200	4.0×
// Subscription — Pro	    $0.0128	2.6×
// Subscription — Studio	$0.0096	1.9×
// Top-up (pay-as-you-go)	$0.0250	5.0×
export const microCentsToCredits = (microCents: number): number => {
  if (!Number.isFinite(microCents) || microCents <= 0) return 0;
  return Math.ceil(microCents / MICROCENTS_PER_CREDIT);
};

// User-facing $/credit by funding source. Derived directly from PLANS so
// any monthlyUsd / monthlyAllowance change cascades automatically. Used by
// the engineer billing view to translate per-row credits into the dollars
// the user effectively paid given which balance bucket covered them.
export const PLAN_USD_PER_CREDIT: Record<PlanKey, number> = {
  free: 0,
  starter: PLANS.starter.monthlyUsd / PLANS.starter.monthlyAllowance,
  pro: PLANS.pro.monthlyUsd / PLANS.pro.monthlyAllowance,
  studio: PLANS.studio.monthlyUsd / PLANS.studio.monthlyAllowance,
};

// ──────────────────────────────────────────────────────────────────────
// Top-up rate (variable-amount, pay-as-you-go)
// ──────────────────────────────────────────────────────────────────────
//
// Users pick any whole-dollar amount between TOPUP_MIN_USD and TOPUP_MAX_USD
// and receive `amountUsd × TOPUP_CREDITS_PER_USD` credits in their bonus
// balance. Rate is calibrated so top-ups are ~25% more expensive per credit
// than the Starter subscription — keeps recurring subscriptions the "cheap
// lane" while variable top-ups serve pay-as-you-go users.
//
//   Starter (5×) = $12.99 / 650 cr  = $0.01998/cr
//   Top-up rate  = $1.00   / 40 cr  = $0.02500/cr   (~25% above Starter)
//
// Integer-only dollars keeps the credit grant exact: `amountUsd * 40` is
// always an integer. Cents would need rounding (e.g. $5.01 × 40 = 200.4 cr)
// and the rounding policy becomes a footgun nobody wants to audit later.
export const TOPUP_CREDITS_PER_USD = 40;
export const TOPUP_USD_PER_CREDIT = 1 / TOPUP_CREDITS_PER_USD;
export const TOPUP_MIN_USD = 5;
export const TOPUP_MAX_USD = 500;
