/**
 * The money-path guarantee, executable at last: **a credit debit is never
 * written without its audit row.**
 *
 * The production bug this file exists to prevent: `debitActualSpend` decrements
 * `credits.allowanceBalance` and inserts a `CreditLedger` row inside one
 * `withCreditTransaction`. If those ever stop being atomic — a refactor that
 * moves the insert out, a swallowed error between them, a crash — the balance
 * drops with no audit trail. That is silent revenue/accounting divergence found
 * at reconciliation, not at request time. Before this file the transactional
 * branch had **never executed under test**: `dbTransaction.ts:42` short-circuits
 * on `ENVIRONMENT !== 'production'` and `test-setup.ts` stubs `'test'`, so the
 * suite was architecturally incapable of catching it.
 *
 * The seam is a file-scoped `vi.mock('@conf/env')` and NOTHING in production is
 * modified. `dbTransaction.ts` imports only `mongoose` and `@conf/env`, and no
 * module in `creditService`'s collaborator graph reads `@conf/env`, so this
 * flips exactly one branch in exactly one module. `withCreditTransaction` has
 * six call sites; because the mock is per-file, the other four
 * (`recallContentService`, `signupCreditGrantService`, `stripeWebhookService`
 * ×2) are untouched and keep their existing behaviour.
 *
 * `importOriginal` is spread deliberately: a bare
 * `vi.mock('@conf/env', () => ({ ENVIRONMENT: 'production' }))` would drop the
 * other ~36 exports and break any collaborator that reads one.
 *
 * MUTATION CHECK — the only way to know this file is real. Comment out the
 * `vi.mock` block and re-run: the rollback tests MUST fail, because without a
 * transaction the `$inc` has already committed by the time the ledger insert
 * throws. If they still pass, the mock was not hoisted and the file is proving
 * nothing.
 *
 * Requires the replica set from `test-globalSetup.ts`; `db.smoke.test.ts`
 * asserts the topology so this cannot silently degrade.
 *
 * Run: yarn test creditService.transaction
 */

import { describe, test, expect, vi, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb, ensureCollections } from '../../test-helpers/db';
import { makeUser, UserModel } from '../../test-helpers/factories';
import { runWithUsageContext } from '@lib/usageContext';

vi.mock('@conf/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@conf/env')>()),
  ENVIRONMENT: 'production',
}));

// The socket emit needs a booted Socket.io server; it is not the subject here.
vi.mock('@lib/creditSocket', () => ({
  emitCreditsUpdated: vi.fn(),
}));

import { ENVIRONMENT } from '@conf/env';
import { debitActualSpend, getBalance } from '@services/creditService';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { PLANS } from '@lib/creditPricing';

setupTestDb();

// Collections must exist BEFORE the first transactional write — see
// `ensureCollections`.
beforeAll(async () => {
  await ensureCollections(UserModel, CreditLedgerModel);
});

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

const debitInScope = (params: { userId: mongoose.Types.ObjectId; microCents: number }) =>
  runWithUsageContext({
    ctx: {
      userId: params.userId.toString(),
      source: 'job',
      spendMicroCents: { current: params.microCents },
    },
    fn: () =>
      debitActualSpend({
        userId: params.userId,
        jobId: new mongoose.Types.ObjectId(),
        jobType: 'generate_lesson',
      }),
  });

describe('debitActualSpend inside a REAL transaction', () => {
  test('the file-scoped mock really flipped ENVIRONMENT (guards every test below)', () => {
    // Without this, a silently-unhoisted mock would make the rollback tests
    // pass for the wrong reason.
    expect(ENVIRONMENT).toBe('production');
  });

  test('happy path: balance decrement AND ledger row both commit', async () => {
    const user = await seedUser({ allowance: 100 });

    await debitInScope({ userId: user._id, microCents: 25_000 }); // 5 credits

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(95);

    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('debit_action');
    expect(ledger[0].delta).toBe(-5);
    expect(ledger[0].balanceBefore).toBe(100);
    expect(ledger[0].balanceAfter).toBe(95);
  });

  test('ROLLBACK: a failing ledger insert leaves the balance UNTOUCHED — no un-audited debit', async () => {
    const user = await seedUser({ allowance: 100 });
    const spy = vi
      .spyOn(CreditLedgerModel, 'create')
      .mockRejectedValue(new Error('ledger write failed mid-transaction') as never);

    try {
      await expect(debitInScope({ userId: user._id, microCents: 25_000 })).rejects.toThrow(
        'ledger write failed mid-transaction',
      );
    } finally {
      spy.mockRestore();
    }

    const after = await UserModel.findById(user._id).lean();
    // THE assertion. Non-transactionally this reads 95: the $inc committed and
    // the audit row did not — a debit with no ledger entry, in production, for
    // real money.
    expect(after?.credits.allowanceBalance).toBe(100);
    expect(await CreditLedgerModel.countDocuments({ userId: user._id })).toBe(0);
  });

  test('ROLLBACK is scoped: a later, healthy debit for the same user still commits', async () => {
    // Fail-closed in one direction must not mean broken in the other — an
    // aborted transaction must not poison the session for subsequent work.
    const user = await seedUser({ allowance: 100 });

    const spy = vi
      .spyOn(CreditLedgerModel, 'create')
      .mockRejectedValueOnce(new Error('transient ledger failure') as never);
    try {
      await expect(debitInScope({ userId: user._id, microCents: 25_000 })).rejects.toThrow(
        'transient ledger failure',
      );
    } finally {
      spy.mockRestore();
    }

    await debitInScope({ userId: user._id, microCents: 25_000 });

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(95);
    expect(await CreditLedgerModel.countDocuments({ userId: user._id })).toBe(1);
  });

  test('the ledger sum reconciles to the balance delta across several debits', async () => {
    const user = await seedUser({ allowance: 100 });
    const before = 100;

    await debitInScope({ userId: user._id, microCents: 25_000 });
    await debitInScope({ userId: user._id, microCents: 10_000 });
    await debitInScope({ userId: user._id, microCents: 5_000 });

    const after = await UserModel.findById(user._id).lean();
    const balanceAfter =
      (after?.credits.allowanceBalance ?? 0) + (after?.credits.bonusBalance ?? 0);

    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    const ledgerSum = ledger.reduce((acc, row) => acc + row.delta, 0);

    expect(ledgerSum).toBe(-(before - balanceAfter));
    expect(ledger).toHaveLength(3);
  });
});

describe('applyFreePeriodReset inside a REAL transaction', () => {
  /** Expire the free window so the next `getBalance` triggers the lazy reset. */
  const expirePeriod = async (userId: mongoose.Types.ObjectId, spentTo: number) => {
    const past = new Date(Date.now() - 60_000);
    await UserModel.updateOne(
      { _id: userId },
      {
        $set: {
          'credits.allowanceBalance': spentTo,
          'credits.periodStart': new Date(past.getTime() - 30 * 24 * 60 * 60 * 1000),
          'credits.periodEnd': past,
        },
      },
    );
    return past;
  };

  test('happy path: a fresh allowance and its period_reset ledger row both commit', async () => {
    const user = await makeUser();
    await expirePeriod(user._id, 2);

    const balance = await getBalance(user._id);

    expect(balance.allowance).toBe(PLANS.free.monthlyAllowance);
    const rows = await CreditLedgerModel.find({ userId: user._id, reason: 'period_reset' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].balanceAfter).toBe(PLANS.free.monthlyAllowance);
  });

  test('ROLLBACK: a failing ledger insert leaves the OLD period in place — no un-audited grant', async () => {
    const user = await makeUser();
    const priorPeriodEnd = await expirePeriod(user._id, 2);

    const spy = vi
      .spyOn(CreditLedgerModel, 'create')
      .mockRejectedValue(new Error('period_reset ledger write failed') as never);

    try {
      await expect(getBalance(user._id)).rejects.toThrow('period_reset ledger write failed');
    } finally {
      spy.mockRestore();
    }

    const after = await UserModel.findById(user._id).lean();
    // Non-transactionally the $set committed: the user would hold a fresh
    // month's allowance with no audit row and a rolled-forward period end.
    expect(after?.credits.allowanceBalance).toBe(2);
    expect(after?.credits.periodEnd.getTime()).toBe(priorPeriodEnd.getTime());
    expect(await CreditLedgerModel.countDocuments({ userId: user._id })).toBe(0);
  });
});
