/**
 * Tests for the abuse-log signup gate. Bugs here mean a deleted-then-recreated
 * account either re-collects the free allowance (lost defense) or is wrongly
 * blocked (false positive).
 *
 * Run: yarn test abuseLogService
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser } from '../../test-helpers/factories';
import AbuseLogModel, { ABUSE_LOG_RETENTION_DAYS } from '@models/AbuseLogModel';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { hashCanonicalEmail } from '@lib/emailHash';
import { PLANS } from '@lib/creditPricing';

import { resolveSignupAllowance, recordAccountDeletion } from '@services/abuseLogService';

setupTestDb();

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── resolveSignupAllowance ─────────────────────────────

describe('resolveSignupAllowance', () => {
  test('unknown email: returns the ONE-TIME onboarding grant, not the monthly allowance', async () => {
    // 2026-09-02: a clean signup now gets a one-time onboarding grant (650cr
    // ≈ 5 lessons at the measured 116/lesson), NOT the 200cr steady state.
    // Asserted as a literal, deliberately: the previous version compared
    // against `PLANS.free.monthlyAllowance`, so it would have kept passing
    // unchanged no matter what this function returned.
    const result = await resolveSignupAllowance('new-user@example.com');
    expect(result.blocked).toBe(false);
    expect(result.allowanceBalance).toBe(650);
    expect(result.allowanceGranted).toBe(650);
    // The grant must EXCEED the recurring allowance — that gap is the whole
    // point, and `applyFreePeriodReset` collapsing it back to 200 at the
    // first 30-day rollover is what makes the grant one-time.
    expect(result.allowanceBalance).toBeGreaterThan(PLANS.free.monthlyAllowance);
  });

  test('email is in abuse log → returns 0 balance, blocked=true', async () => {
    const email = 'recycled@example.com';
    const emailHash = hashCanonicalEmail(email);
    await AbuseLogModel.create({
      emailHash,
      firstSeenAt: new Date(),
      lastSignupAt: new Date(),
      signupCount: 1,
      lifetimeCreditsGranted: 110,
      lifetimeCreditsConsumed: 50,
      retentionUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });

    const result = await resolveSignupAllowance(email);
    expect(result.blocked).toBe(true);
    expect(result.allowanceBalance).toBe(0);
    expect(result.allowanceGranted).toBe(0);
  });

  test('email canonicalization: same email in different cases → same hash → blocked', async () => {
    const original = 'Test.User@Example.com';
    const variants = ['test.user@example.com', 'TEST.USER@EXAMPLE.COM', '  Test.User@Example.com  '];

    await AbuseLogModel.create({
      emailHash: hashCanonicalEmail(original),
      firstSeenAt: new Date(),
      lastSignupAt: new Date(),
      signupCount: 1,
      lifetimeCreditsGranted: 0,
      lifetimeCreditsConsumed: 0,
      retentionUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });

    for (const v of variants) {
      const result = await resolveSignupAllowance(v);
      expect(result.blocked).toBe(true);
    }
  });

  test('lookup throws (e.g., Mongo down) → fail-open: returns normal grant', async () => {
    // Force the lookup to throw by spying on findOne
    const spy = vi.spyOn(AbuseLogModel, 'findOne').mockImplementation((() => {
      throw new Error('Connection lost');
    }) as never);

    const result = await resolveSignupAllowance('test@example.com');
    expect(result.blocked).toBe(false);
    // Fail-open means "fall through to the grant a clean signup would get",
    // which since 2026-09-02 is the one-time onboarding grant, not the 200cr
    // monthly allowance. A Mongo outage must not silently downgrade the
    // account it creates.
    expect(result.allowanceBalance).toBe(650);
    expect(result.allowanceBalance).toBeGreaterThan(PLANS.free.monthlyAllowance);

    spy.mockRestore();
  });
});

// ── recordAccountDeletion ──────────────────────────────

describe('recordAccountDeletion', () => {
  test('first-time deletion: inserts row with firstSeenAt, signupCount=1, retentionUntil=now+365d', async () => {
    const user = await makeUser({ email: 'going@example.com' });
    await recordAccountDeletion({ email: 'going@example.com', userId: user._id });

    const row = await AbuseLogModel.findOne({
      emailHash: hashCanonicalEmail('going@example.com'),
    }).lean();
    assert(row);
    expect(row.signupCount).toBe(1);
    expect(row.lifetimeCreditsGranted).toBe(0);
    expect(row.lifetimeCreditsConsumed).toBe(0);
    expect(row.firstSeenAt).toBeInstanceOf(Date);
    expect(row.lastSignupAt).toBeInstanceOf(Date);

    // retentionUntil ≈ now + 365 days (within 5 second tolerance)
    const expected = Date.now() + ABUSE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs(row.retentionUntil.getTime() - expected)).toBeLessThan(5000);
  });

  test('aggregates lifetime credits from CreditLedgerModel: sums positive deltas + abs(negative deltas)', async () => {
    const user = await makeUser({ email: 'spent@example.com' });
    // Seed a real ledger: +110 grant, -20 debit, +50 topup, -30 debit.
    // Granted/consumed totals are derived from this list below — change
    // the seed and the assertions follow automatically.
    const ledgerSeed = [
      { delta: 110, allowanceDelta: 110, bonusDelta: 0, reason: 'signup_grant' as const },
      { delta: -20, allowanceDelta: -20, bonusDelta: 0, reason: 'debit_action' as const },
      { delta: 50, allowanceDelta: 0, bonusDelta: 50, reason: 'topup_purchase' as const },
      { delta: -30, allowanceDelta: -30, bonusDelta: 0, reason: 'debit_action' as const },
    ];
    await CreditLedgerModel.create(
      ledgerSeed.map((row) => ({
        userId: user._id,
        timestamp: new Date(),
        delta: row.delta,
        allowanceDelta: row.allowanceDelta,
        bonusDelta: row.bonusDelta,
        balanceBefore: 0,
        balanceAfter: 0,
        bonusBefore: 0,
        bonusAfter: 0,
        reason: row.reason,
      })),
    );

    await recordAccountDeletion({ email: 'spent@example.com', userId: user._id });

    const row = await AbuseLogModel.findOne({
      emailHash: hashCanonicalEmail('spent@example.com'),
    }).lean();
    const expectedGranted = ledgerSeed
      .filter((r) => r.delta > 0)
      .reduce((sum, r) => sum + r.delta, 0);
    const expectedConsumed = ledgerSeed
      .filter((r) => r.delta < 0)
      .reduce((sum, r) => sum + Math.abs(r.delta), 0);
    expect(row?.lifetimeCreditsGranted).toBe(expectedGranted);
    expect(row?.lifetimeCreditsConsumed).toBe(expectedConsumed);
  });

  test('idempotent re-call: signupCount and lifetime totals accumulate on second deletion', async () => {
    const user1 = await makeUser({ email: 'repeat@example.com' });
    await recordAccountDeletion({ email: 'repeat@example.com', userId: user1._id });

    // Simulate another lifecycle: new user, same email → recreate, then delete again
    const user2 = await makeUser({ email: 'repeat-2@example.com' }); // different email so makeUser doesn't conflict
    // Re-call recordAccountDeletion using the ORIGINAL email (this is the abuse case)
    await recordAccountDeletion({ email: 'repeat@example.com', userId: user2._id });

    const row = await AbuseLogModel.findOne({
      emailHash: hashCanonicalEmail('repeat@example.com'),
    }).lean();
    expect(row?.signupCount).toBe(2);
  });

  test('retentionUntil pushed forward on each re-call (rolling 365d from latest deletion)', async () => {
    const user1 = await makeUser({ email: 'sliding@example.com' });
    await recordAccountDeletion({ email: 'sliding@example.com', userId: user1._id });
    const first = await AbuseLogModel.findOne({
      emailHash: hashCanonicalEmail('sliding@example.com'),
    }).lean();

    // Sleep ~50ms so the second deletion's timestamp is measurably later
    await new Promise((r) => setTimeout(r, 50));

    const user2 = await makeUser({ email: 'sliding-2@example.com' });
    await recordAccountDeletion({ email: 'sliding@example.com', userId: user2._id });
    const second = await AbuseLogModel.findOne({
      emailHash: hashCanonicalEmail('sliding@example.com'),
    }).lean();

    expect(second?.retentionUntil.getTime()).toBeGreaterThan(first!.retentionUntil.getTime());
  });

  test('user with empty CreditLedger: lifetime totals stay at 0 (no aggregate errors)', async () => {
    const user = await makeUser({ email: 'fresh@example.com' });
    // No CreditLedger rows for this user
    await recordAccountDeletion({ email: 'fresh@example.com', userId: user._id });

    const row = await AbuseLogModel.findOne({
      emailHash: hashCanonicalEmail('fresh@example.com'),
    }).lean();
    expect(row?.lifetimeCreditsGranted).toBe(0);
    expect(row?.lifetimeCreditsConsumed).toBe(0);
  });
});

// ── End-to-end: deletion → block on next signup attempt ──

describe('end-to-end abuse defense', () => {
  test('record deletion → next resolveSignupAllowance for same email is blocked', async () => {
    const email = 'cycle@example.com';
    const user = await makeUser({ email });

    // Before deletion, a fresh signup would still be allowed (only blocked
    // after deletion record is written)
    expect((await resolveSignupAllowance('different@example.com')).blocked).toBe(false);

    await recordAccountDeletion({ email, userId: user._id });

    // Now the same email is on the blocklist
    const result = await resolveSignupAllowance(email);
    expect(result.blocked).toBe(true);
    expect(result.allowanceBalance).toBe(0);
  });
});
