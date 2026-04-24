/**
 * Tests for stripeService price-ID mapping. Env vars (Stripe price IDs +
 * required core vars) are stubbed by `test-setup.ts` before any module loads.
 *
 * Run: yarn test stripeService
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  mapPriceIdToPlan,
  resolveSubscriptionPriceId,
} from './stripeService';



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

