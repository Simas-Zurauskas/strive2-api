/**
 * Self-executing tests for stripeService price-ID mapping. The mapping
 * functions read env vars at module load, so this test stubs those vars
 * BEFORE importing — a module-load re-bind is cheaper than carving out
 * a pure helper just for testability.
 *
 * Run: yarn test:stripe-service
 */

import assert from 'node:assert/strict';

// Must populate BEFORE importing `@conf/env` (which exits on missing
// required vars). Values are fake — price IDs here never hit Stripe.
process.env.ENVIRONMENT = process.env.ENVIRONMENT || 'test';
process.env.BFL_API_KEY = process.env.BFL_API_KEY || 'test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test';
process.env.MAILJET_API_KEY = process.env.MAILJET_API_KEY || 'test';
process.env.MAILJET_API_SECRET = process.env.MAILJET_API_SECRET || 'test';
process.env.TAVILY_API_KEY = process.env.TAVILY_API_KEY || 'test';
process.env.JINA_API_KEY = process.env.JINA_API_KEY || 'test';
process.env.JUDGE0_API_KEY = process.env.JUDGE0_API_KEY || 'test';
process.env.JUDGE0_API_URL = process.env.JUDGE0_API_URL || 'http://localhost/judge0';
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || 'test';
process.env.AWS_S3_REGION = process.env.AWS_S3_REGION || 'test';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test';

// Stripe auth vars — required by env.ts even though not exercised here.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_stub';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_stub';

// Price IDs — the thing actually under test. Top-ups no longer use fixed
// Price IDs (they use inline `price_data` per Checkout session), so only
// subscription price IDs need stubbing here.
process.env.STRIPE_PRICE_ID_STARTER_MONTHLY = 'price_starter_mo';
process.env.STRIPE_PRICE_ID_STARTER_ANNUAL = 'price_starter_yr';
process.env.STRIPE_PRICE_ID_PRO_MONTHLY = 'price_pro_mo';
process.env.STRIPE_PRICE_ID_PRO_ANNUAL = 'price_pro_yr';
process.env.STRIPE_PRICE_ID_STUDIO_MONTHLY = 'price_studio_mo';
process.env.STRIPE_PRICE_ID_STUDIO_ANNUAL = 'price_studio_yr';

import {
  mapPriceIdToPlan,
  resolveSubscriptionPriceId,
} from './stripeService';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log('stripeService.mapping');

// ── mapPriceIdToPlan ──────────────────────────────────────

test('maps starter monthly price id → { plan: starter, cadence: monthly }', () => {
  assert.deepEqual(mapPriceIdToPlan('price_starter_mo'), { plan: 'starter', cadence: 'monthly' });
});

test('maps starter annual price id → { plan: starter, cadence: annual }', () => {
  assert.deepEqual(mapPriceIdToPlan('price_starter_yr'), { plan: 'starter', cadence: 'annual' });
});

test('maps pro monthly → pro/monthly', () => {
  assert.deepEqual(mapPriceIdToPlan('price_pro_mo'), { plan: 'pro', cadence: 'monthly' });
});

test('maps pro annual → pro/annual', () => {
  assert.deepEqual(mapPriceIdToPlan('price_pro_yr'), { plan: 'pro', cadence: 'annual' });
});

test('maps studio monthly → studio/monthly', () => {
  assert.deepEqual(mapPriceIdToPlan('price_studio_mo'), { plan: 'studio', cadence: 'monthly' });
});

test('maps studio annual → studio/annual', () => {
  assert.deepEqual(mapPriceIdToPlan('price_studio_yr'), { plan: 'studio', cadence: 'annual' });
});

test('unknown price id → null', () => {
  assert.equal(mapPriceIdToPlan('price_nonexistent'), null);
});

test('null / undefined / empty price id → null (safe for stale webhook data)', () => {
  assert.equal(mapPriceIdToPlan(null), null);
  assert.equal(mapPriceIdToPlan(undefined), null);
  assert.equal(mapPriceIdToPlan(''), null);
});

// ── resolveSubscriptionPriceId (inverse) ──────────────────────

test('round-trip: plan/cadence → price id → plan/cadence preserves identity', () => {
  const cases: Array<{ plan: 'starter' | 'pro' | 'studio'; cadence: 'monthly' | 'annual' }> = [
    { plan: 'starter', cadence: 'monthly' },
    { plan: 'starter', cadence: 'annual' },
    { plan: 'pro', cadence: 'monthly' },
    { plan: 'pro', cadence: 'annual' },
    { plan: 'studio', cadence: 'monthly' },
    { plan: 'studio', cadence: 'annual' },
  ];
  for (const c of cases) {
    const id = resolveSubscriptionPriceId(c);
    assert.ok(id, `expected price id for ${c.plan}/${c.cadence}`);
    assert.deepEqual(mapPriceIdToPlan(id), c);
  }
});

test('resolveSubscriptionPriceId returns null for unknown combinations', () => {
  // @ts-expect-error — deliberately invalid combo
  assert.equal(resolveSubscriptionPriceId({ plan: 'starter', cadence: 'quarterly' }), null);
});

// Top-up mapping tests removed: top-ups now use inline `price_data` with
// credits stamped in session metadata, so there's no price-ID ↔ credits
// lookup to verify. Webhook attribution reads `session.metadata.credits`
// directly — that's exercised by stripeWebhookService, not here.

// ── Done ──────────────────────────────────────────────────

console.log(`\n✓ ${passed} test(s) passed`);
