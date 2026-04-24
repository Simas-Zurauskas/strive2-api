/**
 * Self-executing tests for the credit-pricing module. Follows the zero-framework
 * style used elsewhere in the repo.
 *
 * Run: yarn test:credit-pricing
 */

import assert from 'node:assert/strict';
import {
  MICROCENTS_PER_CREDIT,
  PLANS,
  PLAN_KEYS,
  TOPUP_CREDITS_PER_USD,
  TOPUP_MAX_USD,
  TOPUP_MIN_USD,
  microCentsToCredits,
} from './creditPricing';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log('creditPricing');

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
    assert.equal(typeof plan.allowImage, 'boolean');
    assert.equal(typeof plan.allowLinks, 'boolean');
  }
});

test('every plan grants full feature access (images + links)', () => {
  for (const key of PLAN_KEYS) {
    assert.equal(PLANS[key].allowImage, true, `${key} must allow image`);
    assert.equal(PLANS[key].allowLinks, true, `${key} must allow links`);
  }
});

test('allowances increase strictly across tiers', () => {
  assert.ok(PLANS.free.monthlyAllowance < PLANS.starter.monthlyAllowance);
  assert.ok(PLANS.starter.monthlyAllowance < PLANS.pro.monthlyAllowance);
  assert.ok(PLANS.pro.monthlyAllowance < PLANS.studio.monthlyAllowance);
});

test('paid-plan allowances are exact 5x/15x/40x multiples of Free', () => {
  const unit = PLANS.free.monthlyAllowance;
  assert.equal(PLANS.starter.monthlyAllowance, unit * 5);
  assert.equal(PLANS.pro.monthlyAllowance, unit * 15);
  assert.equal(PLANS.studio.monthlyAllowance, unit * 40);
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

// ── Done ──────────────────────────────────────────────────

console.log(`\n✓ ${passed} test(s) passed`);
