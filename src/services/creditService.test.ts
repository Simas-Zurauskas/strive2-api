/**
 * Tests for the credit accounting service. Covers:
 *   - getBalance happy path + lazy free-period reset at boundary
 *   - applyFreePeriodReset CAS race (only first writer wins)
 *   - debitActualSpend successful debit, clamping, retry under contention,
 *     exhausted-retry warning path
 *   - Error class shape (statusCode + errorCode + meta)
 *
 * Strategy:
 *   - In-memory Mongo via setupTestDb provides real User + CreditLedger writes
 *   - vi.mock('@lib/creditSocket', ...) no-ops the socket emit
 *   - vi.mock('@sentry/node', ...) no-ops Sentry capture so the exhausted-retry
 *     test doesn't throw at "missing DSN"
 *
 * Run: yarn test creditService
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, UserModel } from '../../test-helpers/factories';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { PLANS } from '@lib/creditPricing';
import { runWithUsageContext } from '@lib/usageContext';

vi.mock('@lib/creditSocket', () => ({
  emitCreditsUpdated: vi.fn(),
}));

// `creditService` reports the exhausted-retry warning through the
// canonical `errorReporter` wrapper rather than calling Sentry directly,
// so the mock surface is the wrapper. The wrapper itself is unit-tested
// separately; here we just assert the wrapper was invoked.
vi.mock('@lib/errorReporter', () => ({
  captureError: vi.fn(),
  captureWarning: vi.fn(),
  addBreadcrumb: vi.fn(),
  setSentryUser: vi.fn(),
}));

import {
  getBalance,
  debitActualSpend,
  InsufficientCreditsError,
  MaxConcurrentJobsError,
} from '@services/creditService';
import { recordUsage } from '@services/usageService';
import UsageEventModel from '@models/UsageEventModel';
import * as errorReporter from '@lib/errorReporter';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Error class shapes ──────────────────────────────────

describe('Error classes', () => {
  test('InsufficientCreditsError carries statusCode 402 + errorCode + meta', () => {
    const err = new InsufficientCreditsError({ need: 1, have: 0 });
    expect(err.statusCode).toBe(402);
    expect(err.errorCode).toBe('INSUFFICIENT_CREDITS');
    expect(err.meta).toEqual({ need: 1, have: 0 });
    expect(err.message).toBe('Insufficient credits');
    expect(err).toBeInstanceOf(Error);
  });

  test('MaxConcurrentJobsError carries statusCode 409 + errorCode + meta', () => {
    const err = new MaxConcurrentJobsError({ active: 3, limit: 3 });
    expect(err.statusCode).toBe(409);
    expect(err.errorCode).toBe('TOO_MANY_ACTIVE_JOBS');
    expect(err.meta).toEqual({ active: 3, limit: 3 });
    expect(err.message).toContain('3/3');
  });
});

// ── getBalance ──────────────────────────────────────────

describe('getBalance', () => {
  test('returns the credits subdoc + plan for an unexpired user', async () => {
    const user = await makeUser();
    const balance = await getBalance(user._id);
    expect(balance.allowance).toBe(PLANS.free.monthlyAllowance);
    expect(balance.bonus).toBe(0);
    expect(balance.total).toBe(PLANS.free.monthlyAllowance);
    expect(balance.plan).toBe('free');
  });

  test('throws when the user does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    await expect(getBalance(fakeId)).rejects.toThrow('User not found');
  });

  test('paid plan: does NOT lazy-reset even when periodEnd is past', async () => {
    const user = await makeUser({
      subscription: {
        plan: 'starter',
        status: 'active',
        cancelAtPeriodEnd: false,
      } as never,
    });
    // Force an expired period on a paid user — only Stripe webhooks should
    // touch paid-plan periods, not getBalance.
    const yesterday = new Date(Date.now() - 86400_000);
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          'credits.allowanceBalance': 5,
          'credits.allowanceGranted': 100,
          'credits.periodEnd': yesterday,
        },
      },
    );

    const balance = await getBalance(user._id);
    expect(balance.allowance).toBe(5); // unchanged
    expect(balance.plan).toBe('starter');
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('free plan with expired period: lazy-resets allowance + writes period_reset ledger row', async () => {
    const user = await makeUser();
    // Spent down to 5 + period already expired
    const yesterday = new Date(Date.now() - 86400_000);
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          'credits.allowanceBalance': 5,
          'credits.periodEnd': yesterday,
        },
      },
    );

    const balance = await getBalance(user._id);
    expect(balance.allowance).toBe(PLANS.free.monthlyAllowance);

    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('period_reset');
    expect(ledger[0].balanceBefore).toBe(5);
    expect(ledger[0].balanceAfter).toBe(PLANS.free.monthlyAllowance);
  });

  test('free plan within period: no reset, no ledger row', async () => {
    const user = await makeUser();
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { 'credits.allowanceBalance': 5 } }, // periodEnd still in the future from default
    );
    const balance = await getBalance(user._id);
    expect(balance.allowance).toBe(5); // unchanged
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });
});

// ── applyFreePeriodReset (race protection via CAS on periodEnd) ──

describe('applyFreePeriodReset (CAS race)', () => {
  test('two concurrent getBalance calls at exact boundary → exactly one ledger row', async () => {
    const user = await makeUser();
    const yesterday = new Date(Date.now() - 86400_000);
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          'credits.allowanceBalance': 5,
          'credits.periodEnd': yesterday,
        },
      },
    );

    const [b1, b2] = await Promise.all([getBalance(user._id), getBalance(user._id)]);
    // Both callers see the reset (whichever returned first triggered it; the
    // other read the post-reset row), but the ledger should have exactly 1
    // row — the second update's filter on `periodEnd: yesterday` no-ops
    // because the first write already moved `periodEnd` forward.
    expect(b1.allowance).toBe(PLANS.free.monthlyAllowance);
    expect(b2.allowance).toBe(PLANS.free.monthlyAllowance);
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
  });
});

// ── debitActualSpend ────────────────────────────────────

describe('debitActualSpend', () => {
  const seedUser = async (params: { allowance: number; bonus?: number }) => {
    const user = await makeUser();
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          'credits.allowanceBalance': params.allowance,
          'credits.bonusBalance': params.bonus ?? 0,
        },
      },
    );
    return user;
  };

  const debitInScope = async (params: {
    userId: mongoose.Types.ObjectId;
    microCents: number;
    jobId?: mongoose.Types.ObjectId;
    jobType?: string;
  }) => {
    return runWithUsageContext({
      ctx: {
        userId: params.userId.toString(),
        source: 'job',
        spendMicroCents: { current: params.microCents },
      },
      fn: () =>
        debitActualSpend({
          userId: params.userId,
          jobId: params.jobId ?? new mongoose.Types.ObjectId(),
          jobType: params.jobType ?? 'generate_lesson',
        }),
    });
  };

  test('happy path: debits exactly from allowance, writes ledger row', async () => {
    const user = await seedUser({ allowance: 100 });
    // 1 credit = 5_000 microcents → 25_000 = 5 credits
    await debitInScope({ userId: user._id, microCents: 25_000 });

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(95);
    expect(after?.credits.bonusBalance).toBe(0);
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('debit_action');
    expect(ledger[0].allowanceDelta).toBe(-5);
    expect(Math.abs(ledger[0].bonusDelta)).toBe(0); // tolerate -0
    expect(ledger[0].actionType).toBe('generate_lesson');
  });

  test('spills to bonus when allowance is short', async () => {
    const user = await seedUser({ allowance: 3, bonus: 10 });
    // 5 credits worth of spend
    await debitInScope({ userId: user._id, microCents: 25_000 });

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(0);
    expect(after?.credits.bonusBalance).toBe(8); // 10 − 2
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger[0].allowanceDelta).toBe(-3);
    expect(ledger[0].bonusDelta).toBe(-2);
  });

  test('clamps when total cost exceeds available — eats the difference', async () => {
    const user = await seedUser({ allowance: 2, bonus: 0 });
    // 5 credits cost, but only 2 available
    await debitInScope({ userId: user._id, microCents: 25_000 });

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(0);
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger[0].allowanceDelta).toBe(-2); // clamped to what was available
    expect(Math.abs(ledger[0].bonusDelta)).toBe(0); // tolerate -0
  });

  test('zero balance: no debit, no ledger row', async () => {
    const user = await seedUser({ allowance: 0, bonus: 0 });
    await debitInScope({ userId: user._id, microCents: 25_000 });

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(0);
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('zero microcents: no debit (job had no paid API calls)', async () => {
    const user = await seedUser({ allowance: 100 });
    await debitInScope({ userId: user._id, microCents: 0 });

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(100); // unchanged
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('called outside a usageContext scope: silent no-op (no ledger row)', async () => {
    const user = await seedUser({ allowance: 100 });
    await debitActualSpend({
      userId: user._id,
      jobId: new mongoose.Types.ObjectId(),
      jobType: 'generate_lesson',
    });

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(100);
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('fractional microcent (any non-zero spend) rounds up to ≥ 1 credit', async () => {
    const user = await seedUser({ allowance: 100 });
    // 1 microcent → 0.0002 credits → ceils to 1
    await debitInScope({ userId: user._id, microCents: 1 });

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(99);
  });

  test('two concurrent debits on same user: both succeed via CAS retry', async () => {
    const user = await seedUser({ allowance: 100 });
    // Each costs 5 credits
    await Promise.all([
      debitInScope({ userId: user._id, microCents: 25_000 }),
      debitInScope({ userId: user._id, microCents: 25_000 }),
    ]);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(90);
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(2);
  });
});

// ── End-to-end: recordUsage → debitActualSpend with static markup ──

describe('static-markup integration (recordUsage → debit)', () => {
  test('marked services debit at 2× vendor; anthropic at 1×; ledger preserves vendor', async () => {
    const user = await seedUserOutside({ allowance: 1_000 });
    const jobId = new mongoose.Types.ObjectId();

    await runWithUsageContext({
      ctx: { userId: user._id.toString(), source: 'job', jobId: jobId.toString() },
      fn: async () => {
        recordUsage({ service: 'anthropic', action: 'lesson:content', costMicroCents: 10_000 });
        recordUsage({ service: 'tavily',    action: 'search:advanced', costMicroCents: 16_000 });
        recordUsage({ service: 'bfl',       action: 'image:hero',      costMicroCents: 25_000 });
        recordUsage({ service: 'jina',      action: 'reader:fetch',    costMicroCents: 5_000 });
        recordUsage({ service: 'judge0',    action: 'code:exec',       costMicroCents: 2_000 });
        await debitActualSpend({ userId: user._id, jobId, jobType: 'generate_lesson' });
      },
    });
    // recordUsage's UsageEventModel.create is fire-and-forget (.catch only).
    // Poll briefly for the rows to materialise instead of betting on a fixed
    // microtask flush — keeps the test resilient under CI scheduler jitter.
    for (let i = 0; i < 50; i++) {
      const count = await UsageEventModel.countDocuments({ userId: user._id });
      if (count >= 5) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    // Charged total = 10_000 (1×) + 32_000 + 50_000 + 10_000 + 4_000 (all 2×) = 106_000 μ¢.
    // Credits debited = ceil(106_000 / 5_000) = 22.
    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(1_000 - 22);

    const debitRow = await CreditLedgerModel.findOne({ userId: user._id, reason: 'debit_action' }).lean();
    expect(debitRow?.allowanceDelta).toBe(-22);

    // Vendor cost on the analytics ledger remains the raw vendor numbers — no doubling.
    const usageRows = await UsageEventModel.find({ userId: user._id }).lean();
    const vendorByService = Object.fromEntries(usageRows.map((r) => [r.service, r.costMicroCents]));
    expect(vendorByService).toMatchObject({
      anthropic: 10_000,
      tavily: 16_000,
      bfl: 25_000,
      jina: 5_000,
      judge0: 2_000,
    });
    const chargedByService = Object.fromEntries(
      usageRows.map((r) => [r.service, (r as { chargedMicroCents?: number }).chargedMicroCents]),
    );
    expect(chargedByService).toMatchObject({
      anthropic: 10_000,
      tavily: 32_000,
      bfl: 50_000,
      jina: 10_000,
      judge0: 4_000,
    });
  });

  // Local helper: the `seedUser` from the debitActualSpend describe block isn't in scope here.
  async function seedUserOutside(params: { allowance: number; bonus?: number }) {
    const user = await makeUser();
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          'credits.allowanceBalance': params.allowance,
          'credits.bonusBalance': params.bonus ?? 0,
        },
      },
    );
    return user;
  }
});

// ── debitActualSpend retry exhaustion (force the warning path) ──

describe('debitActualSpend retry exhaustion', () => {
  test('exhausted retries: warns + no debit, no ledger row, captureWarning fires', async () => {
    const user = await makeUser();
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { 'credits.allowanceBalance': 100 } },
    );

    // Force every CAS attempt to lose by stubbing UserModel.updateOne to
    // return modifiedCount: 0 for the debit call. Use spyOn so the spy is
    // restored after the test.
    const originalUpdateOne = UserModel.updateOne.bind(UserModel);
    const spy = vi.spyOn(UserModel, 'updateOne').mockImplementation(((
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      // The debit's update has the $inc on credits.allowanceBalance; recognise
      // it and return modifiedCount: 0 to simulate a lost CAS. Other writes
      // (period reset, etc.) pass through to the real updateOne so the test
      // setup isn't disturbed.
      const inc = update.$inc as Record<string, number> | undefined;
      const isDebit =
        inc !== undefined &&
        typeof inc['credits.allowanceBalance'] === 'number' &&
        (inc['credits.allowanceBalance'] as number) < 0;
      if (isDebit) {
        return Promise.resolve({
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 0,
          upsertedId: null,
        });
      }
      return originalUpdateOne(filter, update);
    }) as never);

    try {
      await runWithUsageContext({
        ctx: {
          userId: user._id.toString(),
          source: 'job',
          spendMicroCents: { current: 25_000 },
        },
        fn: () =>
          debitActualSpend({
            userId: user._id,
            jobId: new mongoose.Types.ObjectId(),
            jobType: 'generate_lesson',
          }),
      });

      expect(await CreditLedgerModel.countDocuments({ reason: 'debit_action' })).toBe(0);
      expect(errorReporter.captureWarning).toHaveBeenCalledOnce();
      expect(errorReporter.captureWarning).toHaveBeenCalledWith(
        'debitActualSpend exhausted retries',
        expect.objectContaining({
          tags: expect.objectContaining({ area: 'credits.debit' }),
        }),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
