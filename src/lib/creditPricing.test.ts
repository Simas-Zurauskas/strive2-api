/**
 * Self-executing tests for the credit-pricing module. Follows the zero-framework
 * style used elsewhere in the repo.
 *
 * Run: yarn test:credit-pricing
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  MICROCENTS_PER_CREDIT,
  PLANS,
  PLAN_KEYS,
  PLAN_USD_PER_CREDIT,
  TOPUP_CREDITS_PER_USD,
  TOPUP_MAX_USD,
  TOPUP_MIN_USD,
  TOPUP_USD_PER_CREDIT,
  microCentsToCredits,
} from './creditPricing';



// ── microCentsToCredits — central cost/credit conversion ────────────

test('0 microcents → 0 credits', () => {
  assert.equal(microCentsToCredits(0), 0);
});

test('negative / NaN → 0 credits (defensive)', () => {
  assert.equal(microCentsToCredits(-100), 0);
  assert.equal(microCentsToCredits(Number.NaN), 0);
  assert.equal(microCentsToCredits(Number.POSITIVE_INFINITY), 0);
});

test('any non-zero spend rounds UP to at least 1 credit', () => {
  assert.equal(microCentsToCredits(1), 1);
  assert.equal(microCentsToCredits(MICROCENTS_PER_CREDIT - 1), 1);
});

test('exact-multiple spend maps to exact credits', () => {
  assert.equal(microCentsToCredits(MICROCENTS_PER_CREDIT), 1);
  assert.equal(microCentsToCredits(MICROCENTS_PER_CREDIT * 2), 2);
  assert.equal(microCentsToCredits(MICROCENTS_PER_CREDIT * 10), 10);
});

test('fractional spend rounds UP — never free-rides', () => {
  assert.equal(microCentsToCredits(MICROCENTS_PER_CREDIT + 1), 2);
  assert.equal(microCentsToCredits(MICROCENTS_PER_CREDIT * 3 - 1), 3);
});

test('real-world spend numbers convert sensibly', () => {
  // Screenshot sample: 1 Haiku utility call at 5530 microcents (0.55¢)
  assert.equal(microCentsToCredits(5_530), 2);
  // clarify:questions ≈ 4000 μ¢ (0.40¢)
  assert.equal(microCentsToCredits(4_000), 1);
  // Full lesson with image+links ≈ 150,000 μ¢ ($0.15)
  assert.equal(microCentsToCredits(150_000), 30);
});

// ── PLANS sanity ──────────────────────────────────────────

test('every PlanKey has a complete PlanDefinition', () => {
  for (const key of PLAN_KEYS) {
    const plan = PLANS[key];
    assert.ok(plan, `plan ${key} missing`);
    assert.equal(plan.key, key);
    assert.ok(plan.displayName.length > 0);
    assert.ok(plan.monthlyAllowance > 0);
    assert.ok(plan.maxConcurrentJobs >= 1);
  }
});

test('allowances increase strictly across tiers', () => {
  assert.ok(PLANS.free.monthlyAllowance < PLANS.starter.monthlyAllowance);
  assert.ok(PLANS.starter.monthlyAllowance < PLANS.pro.monthlyAllowance);
  assert.ok(PLANS.pro.monthlyAllowance < PLANS.studio.monthlyAllowance);
});

test('paid-plan allowances are exact integer multiples of Free', () => {
  // The pricing page surfaces paid tiers as "N× Free" — keep every paid
  // monthlyAllowance an exact integer multiple of Free so the displayed
  // multiplier is never "~N×". The specific multipliers themselves are a
  // business decision tuned in `creditPricing.ts`; the invariant is
  // integer-ness, not the multiplier value.
  const unit = PLANS.free.monthlyAllowance;
  for (const key of PLAN_KEYS) {
    if (key === 'free') continue;
    const ratio = PLANS[key].monthlyAllowance / unit;
    assert.ok(
      Number.isInteger(ratio) && ratio > 1,
      `${key}.monthlyAllowance (${PLANS[key].monthlyAllowance}) must be an integer multiple of Free (${unit}); got ${ratio}×`,
    );
  }
});

// ── Top-up rate economics ──────────────────────────────────

test('top-up rate is an integer credits-per-dollar', () => {
  assert.ok(Number.isInteger(TOPUP_CREDITS_PER_USD), 'rate must be integer to avoid rounding');
  assert.ok(TOPUP_CREDITS_PER_USD > 0, 'rate must be positive');
});

test('top-up bounds are sane (min < max, both positive integers)', () => {
  assert.ok(Number.isInteger(TOPUP_MIN_USD) && TOPUP_MIN_USD > 0);
  assert.ok(Number.isInteger(TOPUP_MAX_USD) && TOPUP_MAX_USD > TOPUP_MIN_USD);
  // Stripe's minimum charge in USD is $0.50 on cards — our min must clear it.
  assert.ok(TOPUP_MIN_USD >= 1);
});

test('top-up per-credit rate exceeds Starter per-credit rate (subs stay cheaper)', () => {
  // Starter is the cheapest paid plan on a per-credit basis; top-ups price
  // above it so recurring subscriptions remain the cheaper lane for
  // anyone using the product consistently.
  const starterPerCredit = 12.99 / PLANS.starter.monthlyAllowance;
  const topupPerCredit = 1 / TOPUP_CREDITS_PER_USD;
  assert.ok(
    topupPerCredit > starterPerCredit,
    `top-up $${topupPerCredit.toFixed(4)}/cr must be > Starter's $${starterPerCredit.toFixed(4)}/cr`,
  );
});

// ── Central-constant economics (margin sanity) ─────────────

test('per-plan gross margin ladder is sane (Free loss leader, paid > 40%)', () => {
  // Each plan's real-cost budget at the central rate. Margin = (userUsd -
  // realCostUsd) / userUsd. Free is a loss leader (no user $); paid tiers
  // must clear 40% to be financially viable after provider overhead.
  const realCostUsd = (credits: number) => credits * (MICROCENTS_PER_CREDIT / 1_000_000) * 100 / 100;
  const margin = (userUsd: number, credits: number) => {
    const cost = realCostUsd(credits);
    return userUsd === 0 ? 0 : (userUsd - cost) / userUsd;
  };
  assert.ok(margin(PLANS.starter.monthlyUsd, PLANS.starter.monthlyAllowance) >= 0.4);
  assert.ok(margin(PLANS.pro.monthlyUsd, PLANS.pro.monthlyAllowance) >= 0.4);
  assert.ok(margin(PLANS.studio.monthlyUsd, PLANS.studio.monthlyAllowance) >= 0.4);
});

// ── Per-credit USD rates (used by engineer billing view) ───

test('PLAN_USD_PER_CREDIT derives from PLANS (monthlyUsd / monthlyAllowance)', () => {
  // The engineer billing view turns per-row credit counts into USD using
  // this map. The contract is `userUsd / userAllowance` — pin the formula
  // structurally so adjusting a plan's price or allowance in PLANS
  // automatically updates the per-credit rate without a test edit. Free
  // is the loss-leader and stays at 0.
  assert.equal(PLAN_USD_PER_CREDIT.free, 0);
  for (const key of PLAN_KEYS) {
    if (key === 'free') continue;
    const expected = PLANS[key].monthlyUsd / PLANS[key].monthlyAllowance;
    assert.ok(
      Math.abs(PLAN_USD_PER_CREDIT[key] - expected) < 1e-9,
      `${key}: expected ${expected}, got ${PLAN_USD_PER_CREDIT[key]}`,
    );
  }
});

test('rates ladder: Studio cheaper per credit than Pro, Pro cheaper than Starter', () => {
  // Bigger plans should always come with a lower per-credit unit cost.
  assert.ok(PLAN_USD_PER_CREDIT.studio < PLAN_USD_PER_CREDIT.pro);
  assert.ok(PLAN_USD_PER_CREDIT.pro < PLAN_USD_PER_CREDIT.starter);
});

test('TOPUP_USD_PER_CREDIT == 1 / TOPUP_CREDITS_PER_USD', () => {
  assert.equal(TOPUP_USD_PER_CREDIT, 1 / TOPUP_CREDITS_PER_USD);
  assert.equal(TOPUP_USD_PER_CREDIT, 0.025);
});

// ── Done ──────────────────────────────────────────────────

