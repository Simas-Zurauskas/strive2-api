/**
 * Strive pricing single source of truth. See `wiki/reference/api/billing/credits-and-pricing.md`
 * for the full model; this file is the editable surface for every pricing knob.
 *
 * ⚠️  Changing `planPricing` requires a coordinated Stripe Price update —
 *     see `wiki/working/stripe-production-setup.md`.
 */

export const PLAN_KEYS = ['free', 'starter', 'pro', 'studio'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'past_due', 'canceling', 'canceled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

// KNOB 1 — credit denomination. Re-denomination only; per-action cost
// scales inversely. Move with extreme care.
const MICROCENTS_PER_CREDIT = 5_000;

// KNOB 2 — allowances = unit × multipliers[plan]. Multipliers MUST stay
// integers — the pricing page renders them verbatim ("10×", "22×").
const ALLOWANCE = {
  unit: 200,
  multipliers: {
    free: 1,
    starter: 10,
    pro: 22,
    studio: 48,
  } as Record<PlanKey, number>,
};

// KNOB 3 — plan prices. Changing these requires a coordinated Stripe Price
// update; see wiki/working/stripe-production-setup.md.
const PLAN_PRICING = {
  free: { monthlyUsd: 0, annualMonthlyUsd: 0 },
  starter: { monthlyUsd: 12.99, annualMonthlyUsd: 10.39 },
  pro: { monthlyUsd: 24.99, annualMonthlyUsd: 19.99 },
  studio: { monthlyUsd: 49.99, annualMonthlyUsd: 39.99 },
} as Record<PlanKey, { monthlyUsd: number; annualMonthlyUsd: number }>;

// KNOB 4 — top-up rail. Bonus credits never expire, spent after allowance,
// and bill lesson scope at the higher `bonus` row of MARKUP.
// Invariant (enforced in pricingConfig.test.ts): top-up $/credit ≥ base
// denomination — subscribe-to-save lives in the markup differential.
// quickPicks must all fall inside [minUsd, maxUsd].
const TOPUP = {
  creditsPerUsd: 200,
  minUsd: 5,
  maxUsd: 500,
  quickPicks: [5, 10, 25, 50, 100] as readonly number[],
};

// KNOB 5 — markup table. Charged cost = vendor cost × MARKUP[category][bucket].
// Read by lib/pricing.ts:applyMarkup and by REFERENCE_COSTS below — editing
// here cascades to every "≈ N lessons" chip and every paid debit.
const MARKUP: Record<'other' | 'lesson', Record<'allowance' | 'bonus', number>> = {
  other: { allowance: 2, bonus: 2 },
  lesson: { allowance: 6, bonus: 8 },
};

// Markup is action-driven, not scope-driven. Only `lesson:content` (the Sonnet
// call that produces the learning artifact) gets the `lesson` row; supporting
// calls inside a lesson job (recall extraction, links, image, search,
// embeddings) bill at `other`. Add an action here to charge it at the premium.
const LESSON_PREMIUM_ACTIONS: ReadonlySet<string> = new Set<string>(['lesson:content']);

export const markupCategoryForAction = (action: string): 'lesson' | 'other' =>
  LESSON_PREMIUM_ACTIONS.has(action) ? 'lesson' : 'other';

// KNOB 6 — vendor cost references for UI lesson-count approximations only;
// real billing meters provider spend post-hoc. Recalibrate when prompts/models
// shift medians > ~15%; see api/VENDOR_COSTS.md.
const BASE_VENDOR_COSTS_MICROCENTS = {
  // Base lesson = mandatory floor only. Per-lesson toggles (hero image,
  // curated links, audio narration) are debited at runtime and intentionally
  // excluded from the UI "≈ N lessons" estimate. Split because action-driven
  // markup applies different factors:
  //   baseLessonContent    → lesson:content Sonnet call → lesson markup
  //   baseLessonSupporting → validation/links/RAG/embed → other markup
  baseLessonContent: 60_000,
  baseLessonSupporting: 17_000,
  recallExtraction_lo: 3_000,
  recallExtraction_hi: 6_000,
  // Course clarify + structure: wide range covers retry storms.
  courseStructure_lo: 15_000,
  courseStructure_hi: 60_000,
  moduleQuiz_lo: 13_000,
  moduleQuiz_hi: 20_000,
  mentorTurn_lo: 1_000,
  mentorTurn_hi: 3_000,
  recallReview_lo: 0,
  recallReview_hi: 1_000,
} as const;

const vendorMicroCentsToCredits = (
  vendorMicroCents: number,
  actionCategory: 'lesson' | 'other',
  creditBucket: 'allowance' | 'bonus',
): number => {
  const charged = vendorMicroCents * MARKUP[actionCategory][creditBucket];
  return Math.ceil(charged / MICROCENTS_PER_CREDIT);
};

// Base lesson splits content (lesson markup) and supporting (other markup),
// then sums — single-point credit cost the UI divides allowances/USD by.
const baseLessonCreditsFor = (creditBucket: 'allowance' | 'bonus'): number => {
  const contentCharged = BASE_VENDOR_COSTS_MICROCENTS.baseLessonContent * MARKUP.lesson[creditBucket];
  const supportingCharged = BASE_VENDOR_COSTS_MICROCENTS.baseLessonSupporting * MARKUP.other[creditBucket];
  return Math.ceil((contentCharged + supportingCharged) / MICROCENTS_PER_CREDIT);
};

const baseLessonSub = baseLessonCreditsFor('allowance');
const baseLessonTopup = baseLessonCreditsFor('bonus');

const REFERENCE_COSTS = {
  lessonCredits: [baseLessonSub, baseLessonSub] as [number, number],
  // Top-up chips must use this, not lessonCredits — bonus credits pay the
  // higher lesson markup, so using the allowance figure overstates lessons/$.
  lessonCreditsTopup: [baseLessonTopup, baseLessonTopup] as [number, number],
  recallCardExtractionCredits: [
    vendorMicroCentsToCredits(BASE_VENDOR_COSTS_MICROCENTS.recallExtraction_lo, 'other', 'allowance'),
    vendorMicroCentsToCredits(BASE_VENDOR_COSTS_MICROCENTS.recallExtraction_hi, 'other', 'allowance'),
  ] as [number, number],
  courseStructureCredits: [
    vendorMicroCentsToCredits(BASE_VENDOR_COSTS_MICROCENTS.courseStructure_lo, 'other', 'allowance'),
    vendorMicroCentsToCredits(BASE_VENDOR_COSTS_MICROCENTS.courseStructure_hi, 'other', 'allowance'),
  ] as [number, number],
  moduleQuizCredits: [
    vendorMicroCentsToCredits(BASE_VENDOR_COSTS_MICROCENTS.moduleQuiz_lo, 'other', 'allowance'),
    vendorMicroCentsToCredits(BASE_VENDOR_COSTS_MICROCENTS.moduleQuiz_hi, 'other', 'allowance'),
  ] as [number, number],
  mentorTurnCredits: [
    vendorMicroCentsToCredits(BASE_VENDOR_COSTS_MICROCENTS.mentorTurn_lo, 'other', 'allowance'),
    vendorMicroCentsToCredits(BASE_VENDOR_COSTS_MICROCENTS.mentorTurn_hi, 'other', 'allowance'),
  ] as [number, number],
  recallReviewCredits: [
    vendorMicroCentsToCredits(BASE_VENDOR_COSTS_MICROCENTS.recallReview_lo, 'other', 'allowance'),
    vendorMicroCentsToCredits(BASE_VENDOR_COSTS_MICROCENTS.recallReview_hi, 'other', 'allowance'),
  ] as [number, number],
} as const;

// KNOB 7 — pricing version stamped onto every UsageEvent and CreditLedger row
// for historical billing audits. Bump on any MARKUP / ALLOWANCE / PLAN_PRICING
// / TOPUP change. Format YYYY-MM-DD with optional `-vN` suffix; increment-only.
const PRICING_VERSION = '2026-05-12';

// KNOB 8 — Free tier allowance refresh cadence. Paid tiers refresh on their
// Stripe billing cycle and ignore this.
const FREE_PERIOD_DAYS = 30;

export const PRICING_CONFIG = {
  microcentsPerCredit: MICROCENTS_PER_CREDIT,
  allowance: ALLOWANCE,
  planPricing: PLAN_PRICING,
  topup: TOPUP,
  markup: MARKUP,
  referenceCosts: REFERENCE_COSTS,
  pricingVersion: PRICING_VERSION,
  freePeriodDays: FREE_PERIOD_DAYS,
} as const;

export type ActionCategory = keyof typeof MARKUP;
export type CreditBucket = keyof (typeof MARKUP)[ActionCategory];

// Derived accessors — UI math must route through these so a knob bump
// cascades to every chip and label without inline recomputation.

export const monthlyAllowanceFor = (key: PlanKey): number =>
  PRICING_CONFIG.allowance.unit * PRICING_CONFIG.allowance.multipliers[key];

export const planMultiplier = (key: PlanKey): number => PRICING_CONFIG.allowance.multipliers[key];

export const usdPerCreditFor = (key: PlanKey): number => {
  const allowance = monthlyAllowanceFor(key);
  const monthlyUsd = PRICING_CONFIG.planPricing[key].monthlyUsd;
  if (allowance === 0 || monthlyUsd === 0) return 0;
  return monthlyUsd / allowance;
};

export const topupUsdPerCredit = (): number => 1 / PRICING_CONFIG.topup.creditsPerUsd;

export const lessonRangeFromCredits = (credits: number): [number, number] => {
  if (!Number.isFinite(credits) || credits <= 0) return [0, 0];
  const [lo, hi] = PRICING_CONFIG.referenceCosts.lessonCredits;
  return [Math.max(0, Math.floor(credits / hi)), Math.max(0, Math.floor(credits / lo))];
};

// Top-up rail must use lessonCreditsTopup (bonus markup), not lessonCredits.
export const lessonRangeFromUsd = (usd: number): [number, number] => {
  if (!Number.isFinite(usd) || usd <= 0) return [0, 0];
  const credits = usd * PRICING_CONFIG.topup.creditsPerUsd;
  const [lo, hi] = PRICING_CONFIG.referenceCosts.lessonCreditsTopup;
  return [Math.max(0, Math.floor(credits / hi)), Math.max(0, Math.floor(credits / lo))];
};

export const savingsVsTopupFor = (key: PlanKey): number => {
  const planPerCredit = usdPerCreditFor(key);
  if (planPerCredit === 0) return 0;
  return Math.max(0, 1 - planPerCredit / topupUsdPerCredit());
};

export const maxSavingsVsTopup = (): number => {
  const paidKeys: PlanKey[] = ['starter', 'pro', 'studio'];
  return Math.max(0, ...paidKeys.map((k) => savingsVsTopupFor(k)));
};
