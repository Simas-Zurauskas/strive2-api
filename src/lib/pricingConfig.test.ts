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
