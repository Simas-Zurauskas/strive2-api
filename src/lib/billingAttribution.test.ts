import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attributeEvent } from './billingAttribution';
import { PLAN_USD_PER_CREDIT, TOPUP_USD_PER_CREDIT } from './creditPricing';

// ── No-attribution branches ──────────────────────────────

test('no ledger → null source / null usd', () => {
  const r = attributeEvent({
    eventChargedMicroCents: 5_000,
    jobTotalChargedMicroCents: 25_000,
    ledger: null,
    planAtTime: 'pro',
  });
  assert.equal(r.source, null);
  assert.equal(r.userPaidUsd, null);
  assert.equal(r.creditsAllowance, 0);
  assert.equal(r.creditsBonus, 0);
});

test('zero job total → null (defensive against divide-by-zero)', () => {
  const r = attributeEvent({
    eventChargedMicroCents: 5_000,
    jobTotalChargedMicroCents: 0,
    ledger: { allowanceDelta: -5, bonusDelta: 0 },
    planAtTime: 'pro',
  });
  assert.equal(r.source, null);
});

test('zero event spend → null', () => {
  const r = attributeEvent({
    eventChargedMicroCents: 0,
    jobTotalChargedMicroCents: 25_000,
    ledger: { allowanceDelta: -5, bonusDelta: 0 },
    planAtTime: 'pro',
  });
  assert.equal(r.source, null);
});

// ── Free-tier clamp (debit fully absorbed) ───────────────

test('Free clamp: ledger 0/0 → source allowance, usd 0', () => {
  const r = attributeEvent({
    eventChargedMicroCents: 1_000,
    jobTotalChargedMicroCents: 1_000,
    ledger: { allowanceDelta: 0, bonusDelta: 0 },
    planAtTime: 'free',
  });
  assert.equal(r.source, 'allowance');
  assert.equal(r.userPaidUsd, 0);
});

// ── Pure-allowance attribution ───────────────────────────

test('pure-allowance Pro: half of a 10-credit debit → 5 credits × Pro rate', () => {
  // Event is half the job's spend; debit was 10 credits all from allowance.
  const r = attributeEvent({
    eventChargedMicroCents: 5_000,
    jobTotalChargedMicroCents: 10_000,
    ledger: { allowanceDelta: -10, bonusDelta: 0 },
    planAtTime: 'pro',
  });
  assert.equal(r.source, 'allowance');
  assert.ok(Math.abs(r.creditsAllowance - 5) < 1e-9);
  assert.equal(r.creditsBonus, 0);
  assert.ok(Math.abs((r.userPaidUsd ?? 0) - 5 * PLAN_USD_PER_CREDIT.pro) < 1e-9);
});

// ── Pure-topup attribution ───────────────────────────────

test('pure-topup: dollars use TOPUP_USD_PER_CREDIT regardless of plan', () => {
  const r = attributeEvent({
    eventChargedMicroCents: 4_000,
    jobTotalChargedMicroCents: 8_000,
    ledger: { allowanceDelta: 0, bonusDelta: -8 },
    planAtTime: 'starter',
  });
  assert.equal(r.source, 'topup');
  assert.ok(Math.abs(r.creditsBonus - 4) < 1e-9);
  assert.equal(r.creditsAllowance, 0);
  assert.ok(Math.abs((r.userPaidUsd ?? 0) - 4 * TOPUP_USD_PER_CREDIT) < 1e-9);
});

// ── Mixed attribution ────────────────────────────────────

test('mixed: usd = allowance × plan rate + bonus × topup rate', () => {
  // Job total spent 6 from allowance + 4 from bonus = 10 credits.
  // Event is 1/4 of the job's chargedMicroCents.
  const r = attributeEvent({
    eventChargedMicroCents: 1_000,
    jobTotalChargedMicroCents: 4_000,
    ledger: { allowanceDelta: -6, bonusDelta: -4 },
    planAtTime: 'starter',
  });
  assert.equal(r.source, 'mixed');
  assert.ok(Math.abs(r.creditsAllowance - 1.5) < 1e-9);
  assert.ok(Math.abs(r.creditsBonus - 1) < 1e-9);
  const expected = 1.5 * PLAN_USD_PER_CREDIT.starter + 1 * TOPUP_USD_PER_CREDIT;
  assert.ok(Math.abs((r.userPaidUsd ?? 0) - expected) < 1e-9);
});

// ── Sum-of-shares preserves the job-level debit ──────────

test('rows in one job sum to the ledger debit total', () => {
  const ledger = { allowanceDelta: -10, bonusDelta: 0 };
  const total = 10_000;
  const events = [3_000, 5_000, 2_000];
  const sum = events.reduce(
    (acc, m) =>
      acc + attributeEvent({
        eventChargedMicroCents: m,
        jobTotalChargedMicroCents: total,
        ledger,
        planAtTime: 'pro',
      }).creditsAllowance,
    0,
  );
  assert.ok(Math.abs(sum - 10) < 1e-9, `sum should be 10, got ${sum}`);
});
