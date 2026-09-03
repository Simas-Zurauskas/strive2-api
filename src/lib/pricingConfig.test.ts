import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  lessonRangeFromCredits,
  lessonRangeFromUsd,
  maxSavingsVsTopup,
  monthlyAllowanceFor,
  PLAN_KEYS,
  planMultiplier,
  PRICING_CONFIG,
  savingsVsTopupFor,
  topupUsdPerCredit,
  usdPerCreditFor,
} from './pricingConfig';

// ── Knob shape: integer multipliers, sane ranges ────────────

test('plan multipliers are integers', () => {
  // Pricing page renders these verbatim ("5×", "12×"). Non-integers
  // would render as "4.5×" which reads as a bug.
  for (const key of PLAN_KEYS) {
    const m = PRICING_CONFIG.allowance.multipliers[key];
    assert.ok(Number.isInteger(m), `${key} multiplier ${m} must be integer`);
    assert.ok(m > 0, `${key} multiplier must be positive`);
  }
});

test('allowance multipliers form a monotonic ladder Free < Starter < Pro < Studio', () => {
  const m = PRICING_CONFIG.allowance.multipliers;
  assert.ok(m.free < m.starter, 'Free < Starter');
  assert.ok(m.starter < m.pro, 'Starter < Pro');
  assert.ok(m.pro < m.studio, 'Pro < Studio');
});

test('plan pricing forms a monotonic ladder Free < Starter < Pro < Studio', () => {
  const p = PRICING_CONFIG.planPricing;
  assert.ok(p.free.monthlyUsd === 0);
  assert.ok(p.free.monthlyUsd < p.starter.monthlyUsd);
  assert.ok(p.starter.monthlyUsd < p.pro.monthlyUsd);
  assert.ok(p.pro.monthlyUsd < p.studio.monthlyUsd);
});

test('annualMonthlyUsd < monthlyUsd for every paid plan (annual must save money)', () => {
  for (const key of PLAN_KEYS) {
    if (key === 'free') continue;
    const p = PRICING_CONFIG.planPricing[key];
    assert.ok(
      p.annualMonthlyUsd < p.monthlyUsd,
      `${key}: annual $${p.annualMonthlyUsd}/mo must be < monthly $${p.monthlyUsd}/mo`,
    );
  }
});

// ── Derived accessors: monthly allowance, usd-per-credit ────

test('monthlyAllowanceFor returns unit × multiplier per plan', () => {
  for (const key of PLAN_KEYS) {
    const expected = PRICING_CONFIG.allowance.unit * PRICING_CONFIG.allowance.multipliers[key];
    assert.equal(monthlyAllowanceFor(key), expected);
  }
});

test('planMultiplier returns the configured multiplier', () => {
  assert.equal(planMultiplier('free'), PRICING_CONFIG.allowance.multipliers.free);
  assert.equal(planMultiplier('studio'), PRICING_CONFIG.allowance.multipliers.studio);
});

test('usdPerCreditFor returns 0 for Free, positive for paid plans', () => {
  assert.equal(usdPerCreditFor('free'), 0);
  for (const key of ['starter', 'pro', 'studio'] as const) {
    const rate = usdPerCreditFor(key);
    assert.ok(rate > 0, `${key} $/credit must be positive`);
    assert.ok(rate < 1, `${key} $/credit must be sub-dollar (sanity)`);
  }
});

test('paid plans descend in $/credit as you go up the ladder', () => {
  // Bigger plans buy credits in bulk — should be cheaper per unit.
  const starter = usdPerCreditFor('starter');
  const pro = usdPerCreditFor('pro');
  const studio = usdPerCreditFor('studio');
  assert.ok(pro < starter, `Pro $${pro.toFixed(4)} must be < Starter $${starter.toFixed(4)}`);
  assert.ok(studio < pro, `Studio $${studio.toFixed(4)} must be < Pro $${pro.toFixed(4)}`);
});

// ── Top-up economics ────────────────────────────────────────

test('topupUsdPerCredit is positive and matches 1/creditsPerUsd', () => {
  assert.equal(topupUsdPerCredit(), 1 / PRICING_CONFIG.topup.creditsPerUsd);
  assert.ok(topupUsdPerCredit() > 0);
});

test('quickPicks all fall inside [minUsd, maxUsd]', () => {
  const { minUsd, maxUsd, quickPicks } = PRICING_CONFIG.topup;
  for (const v of quickPicks) {
    assert.ok(v >= minUsd && v <= maxUsd, `quickPick $${v} outside [$${minUsd}, $${maxUsd}]`);
  }
});

test('top-up $/credit equals the base denomination (no hidden Layer 3 markup)', () => {
  // Under the single-layer model, top-up purchases credits at the same
  // per-credit price as the underlying charged-cost denomination
  // (microcentsPerCredit ÷ 1_000_000). The "subscribe to save" promise
  // lives in the *markup table* (4× allowance vs 5× bonus on lesson scope),
  // not in a $/credit premium on top-up.
  const baseUsdPerCredit = PRICING_CONFIG.microcentsPerCredit / 1_000_000;
  assert.equal(topupUsdPerCredit(), baseUsdPerCredit);
});

test('savingsVsTopupFor returns 0 for free, non-negative for paid plans', () => {
  // Under uniform $/credit, paid plans don't save per credit vs top-up — they
  // save via the markup differential (4× vs 5× on lesson scope), which is
  // tested separately in pricing.test.ts. This accessor is preserved for the
  // engineer billing dashboard but won't drive marketing copy any longer.
  assert.equal(savingsVsTopupFor('free'), 0);
  for (const key of ['starter', 'pro', 'studio'] as const) {
    const s = savingsVsTopupFor(key);
    assert.ok(s >= 0 && s < 1, `${key} savings ${s} should be 0..1 inclusive of 0`);
  }
});

test('maxSavingsVsTopup is non-negative (may be 0 under uniform $/credit)', () => {
  assert.ok(maxSavingsVsTopup() >= 0);
});

// ── Sonnet 5 migration parity (2026-08-01) ──────────────────

test('MARKUP.lesson holds the Sonnet-5 parity values (4.73 allowance / 6.35 bonus)', () => {
  // Parity canary. The 2026-08 MARKUP.lesson cut (6/8 → 4.73/6.35) exists so
  // users keep paying what a base lesson cost before the claude-sonnet-5
  // upgrade — the ~1.36× tokenizer increase is absorbed in margin, by
  // decision (see KNOB 5). These two numbers are what actually price every
  // debit: `applyMarkup` multiplies MEASURED provider spend by them.
  //
  // 2026-09-02: this test previously asserted referenceCosts.lessonCredits
  // === [79, 79] as a *proxy* for "MARKUP was not edited". That proxy
  // conflated two independent things — what users are charged (MARKUP ×
  // measured spend) and what the UI *estimates* (MARKUP × KNOB 6's
  // BASE_VENDOR_COSTS_MICROCENTS). KNOB 6 is documented as feeding UI
  // approximations only, and its own comment invites recalibration when
  // medians drift >15%. Asserting on the derived estimate therefore made a
  // sanctioned KNOB 6 recalibration look like a pricing regression while
  // leaving the real lever unguarded. The canary now watches the lever.
  assert.equal(PRICING_CONFIG.markup.lesson.allowance, 4.73);
  assert.equal(PRICING_CONFIG.markup.lesson.bonus, 6.35);
  // `other` was deliberately left at 2/2 in the same migration: Haiku-driven
  // actions got no costlier, so cutting it would be a pure margin giveaway.
  assert.equal(PRICING_CONFIG.markup.other.allowance, 2);
  assert.equal(PRICING_CONFIG.markup.other.bonus, 2);
});

test('referenceCosts.lessonCredits reflects measured production cost (116 / 152)', () => {
  // KNOB 6 is calibrated to what a lesson ACTUALLY costs, because every
  // "≈ N lessons" figure in the product divides an allowance by this number.
  // Measured from CreditLedger, actionType=generate_lesson, since 2026-07-01:
  // n=86, median 116 credits (mean 112, p75 136, p90 156), trending up
  // (May 94 → Aug 115). The previous 79 overstated every plan's capacity by
  // ~47%, against KNOB 6's own ">15% drift ⇒ recalibrate" threshold.
  //   allowance: ceil((109_000×4.73 + 32_000×2) / 5_000) = 116
  //   bonus:     ceil((109_000×6.35 + 32_000×2) / 5_000) = 152
  assert.equal(PRICING_CONFIG.referenceCosts.lessonCredits[0], 116);
  assert.equal(PRICING_CONFIG.referenceCosts.lessonCredits[1], 116);
  assert.equal(PRICING_CONFIG.referenceCosts.lessonCreditsTopup[0], 152);
  assert.equal(PRICING_CONFIG.referenceCosts.lessonCreditsTopup[1], 152);
});

test('lesson markup differential still favors subscriptions after the Sonnet 5 cut', () => {
  const { lesson } = PRICING_CONFIG.markup;
  assert.ok(lesson.bonus > lesson.allowance, 'bonus lesson markup must stay > allowance');
  // Ratio stays in the neighborhood of the original 8/6 ≈ 1.33 so the
  // subscribe-to-save story is materially unchanged.
  const ratio = lesson.bonus / lesson.allowance;
  assert.ok(ratio > 1.25 && ratio < 1.45, `differential ratio ${ratio.toFixed(3)} drifted out of band`);
});

// ── Reference costs (UI approximations) ─────────────────────

test('referenceCosts.lessonCredits has a positive [lo, hi] tuple with lo <= hi', () => {
  // Lesson cost is a single-point base-lesson estimate (lo === hi → UI
  // renders "≈ N lessons", not a range). Some other reference ranges
  // still have lo < hi where natural variance matters.
  const [lo, hi] = PRICING_CONFIG.referenceCosts.lessonCredits;
  assert.ok(Number.isFinite(lo) && lo > 0);
  assert.ok(Number.isFinite(hi) && hi >= lo);
});

test('lessonRangeFromCredits is monotone non-decreasing in input', () => {
  const small = lessonRangeFromCredits(100);
  const large = lessonRangeFromCredits(1000);
  assert.ok(large[0] >= small[0]);
  assert.ok(large[1] >= small[1]);
});

test('lessonRangeFromCredits returns [0,0] for invalid/zero input', () => {
  assert.deepEqual(lessonRangeFromCredits(0), [0, 0]);
  assert.deepEqual(lessonRangeFromCredits(-5), [0, 0]);
  assert.deepEqual(lessonRangeFromCredits(NaN), [0, 0]);
});

test('lessonRangeFromUsd uses TOP-UP lesson cost (5× markup), not subscription cost', () => {
  // Top-up bonus credits bill lesson scope at 5× markup, so $X buys ~25%
  // fewer lessons than the same X cr from a subscription. This regression
  // existed once when lessonRangeFromUsd reused lessonRangeFromCredits — the
  // top-up control overstated lessons-per-dollar by ~25%.
  const usd = 25;
  const credits = usd * PRICING_CONFIG.topup.creditsPerUsd;
  const [topupLo, topupHi] = PRICING_CONFIG.referenceCosts.lessonCreditsTopup;
  const expected: [number, number] = [Math.floor(credits / topupHi), Math.floor(credits / topupLo)];
  assert.deepEqual(lessonRangeFromUsd(usd), expected);
});

test('lessonRangeFromUsd is strictly less than lessonRangeFromCredits at the same credit count', () => {
  // The subscribe-to-save lever made visible: a top-up dollar buys fewer
  // lessons than the equivalent credit count from a subscription, because
  // top-up bonus credits pay 5× vs allowance's 4× on lesson scope.
  const usd = 50;
  const credits = usd * PRICING_CONFIG.topup.creditsPerUsd;
  const fromTopup = lessonRangeFromUsd(usd);
  const fromCredits = lessonRangeFromCredits(credits);
  assert.ok(fromTopup[1] < fromCredits[1], 'top-up high estimate must be < credit high estimate');
});

test('all referenceCosts ranges are non-negative [lo, hi] tuples with lo <= hi', () => {
  for (const [name, range] of Object.entries(PRICING_CONFIG.referenceCosts)) {
    const [lo, hi] = range as [number, number];
    assert.ok(lo >= 0, `${name} lo ${lo} must be >= 0`);
    assert.ok(hi >= lo, `${name} hi ${hi} must be >= lo ${lo}`);
  }
});

// ── KNOB 9: the one-time onboarding grant ───────────────────

test('the onboarding grant EXCEEDS the recurring free allowance', () => {
  // Without this, setting KNOB 9 below the monthly allowance would turn the
  // "grant" into a silent downgrade for every new account, and every other
  // test in the suite would still pass. The gap between the two numbers is
  // the entire feature.
  const grant = PRICING_CONFIG.onboardingAllowanceCredits;
  assert.ok(grant > monthlyAllowanceFor('free'), `grant ${grant} must exceed the 200cr steady state`);
});

test('the onboarding grant is a positive integer', () => {
  const grant = PRICING_CONFIG.onboardingAllowanceCredits;
  assert.ok(Number.isInteger(grant) && grant > 0);
  // Credits are whole units everywhere else; a fractional grant would render
  // as "650.5" in any admin surface that shows the raw balance.
  assert.equal(grant, Math.floor(grant));
});

test('the grant covers a complete first module, not a fraction of one', () => {
  // Production module 1 is <= 5 lessons in 65 of 67 courses (mean 3.9), and
  // the wizard costs ~47cr before any lesson exists. If a future
  // recalibration of KNOB 6 pushes lesson cost up without KNOB 9 following,
  // the grant quietly stops buying a module and the feature's whole
  // rationale lapses — silently, because nothing else measures it.
  const WIZARD_OVERHEAD_CREDITS = 47;
  const usable = PRICING_CONFIG.onboardingAllowanceCredits - WIZARD_OVERHEAD_CREDITS;
  const [, lessonHigh] = PRICING_CONFIG.referenceCosts.lessonCredits;
  const lessons = Math.floor(usable / lessonHigh);
  assert.ok(lessons >= 5, `grant buys only ${lessons} lesson(s) after wizard overhead; needs >= 5`);
});

test('the grant is denominated for the ALLOWANCE bucket, which is the cheaper rail', () => {
  // The grant is written to `credits.allowanceBalance`. Had it been written
  // as bonus, lessons would bill at MARKUP.lesson.bonus and buy ~24% fewer.
  // This pins the premise that makes the allowance bucket the right home.
  const [allowanceCost] = PRICING_CONFIG.referenceCosts.lessonCredits;
  const [bonusCost] = PRICING_CONFIG.referenceCosts.lessonCreditsTopup;
  assert.ok(bonusCost > allowanceCost, 'bonus lessons must cost more than allowance lessons');
  const grant = PRICING_CONFIG.onboardingAllowanceCredits;
  assert.ok(
    Math.floor(grant / allowanceCost) > Math.floor(grant / bonusCost),
    'the allowance rail must buy strictly more lessons for the same grant',
  );
});
