/**
 * `withCreditTransaction`, driven down its REAL `session.withTransaction`
 * branch — the branch that had never executed in a test run.
 *
 * The production bug this file exists to prevent: **a credit debit committed
 * without its ledger row.** `dbTransaction.ts:42` short-circuits when
 * `ENVIRONMENT !== 'production'` and `test-setup.ts` stubs `'test'`, so every
 * test ran the *non*-transactional path. The atomicity the money path depends
 * on was verified only in the mode where it is not enforced — it could break
 * and fail silently, in production only.
 *
 * The seam is test-only. `dbTransaction.ts` is NOT modified: it imports exactly
 * two things (`mongoose` and `@conf/env`), and `vi.mock` is file-scoped, so the
 * block below flips exactly one branch in exactly one module. The production
 * predicate is byte-identical to what ships.
 *
 * Requires the single-member replica set from `test-globalSetup.ts` —
 * `session.withTransaction` throws on a standalone mongod.
 * `test-helpers/db.smoke.test.ts` asserts the topology, so if it ever silently
 * degrades these tests fail loudly rather than passing through the old branch.
 *
 * The dev/test contract (session is `null`, no transaction) is pinned in the
 * sibling `dbTransaction.nonProd.test.ts` — separate file, because `vi.mock` is
 * hoisted to the top of the module and cannot be scoped to one `describe`.
 *
 * Run: yarn test dbTransaction
 */

import { describe, test, expect, vi, afterEach, beforeAll } from 'vitest';
import mongoose, { type ClientSession } from 'mongoose';
import { setupTestDb, ensureCollections } from '../../test-helpers/db';

vi.mock('@conf/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@conf/env')>()),
  ENVIRONMENT: 'production',
}));

import { withCreditTransaction } from '@lib/dbTransaction';
import { ENVIRONMENT } from '@conf/env';
import CourseModel from '@models/CourseModel';

setupTestDb();

// Collections must exist BEFORE the first transactional write — see
// `ensureCollections`. Without this the first test to touch CourseModel
// intermittently dies on `Unable to acquire IX lock … within 5ms`.
beforeAll(async () => {
  await ensureCollections(CourseModel);
});

const makeCoursePayload = (userId: mongoose.Types.ObjectId, name: string) => ({
  userId,
  name,
  slug: `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  goal: 'transaction fixture',
  status: 'ready' as const,
});

/**
 * Wrap `mongoose.startSession` so the test can inspect the session the wrapper
 * created without exporting anything from production code. Returns the spy so
 * each test restores it explicitly — no blanket `restoreAllMocks` in an
 * afterEach, which is how a stub gets silently un-installed mid-file.
 */
const captureSession = () => {
  const box: { session: ClientSession | null } = { session: null };
  const real = mongoose.startSession.bind(mongoose);
  const spy = vi.spyOn(mongoose, 'startSession').mockImplementation((async (...args: never[]) => {
    const session = await real(...args);
    box.session = session;
    return session;
  }) as never);
  return { box, spy };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withCreditTransaction — production branch', () => {
  test('the file-scoped mock really flipped ENVIRONMENT (guards every test below)', () => {
    // If this reads 'test', every assertion in this file is silently
    // exercising the non-transactional path and proving nothing.
    expect(ENVIRONMENT).toBe('production');
  });

  test('the callback receives a NON-NULL session that is inside a transaction', async () => {
    let seen: ClientSession | null | undefined;
    let inTransaction: boolean | undefined;

    await withCreditTransaction(async (session) => {
      seen = session;
      inTransaction = session?.inTransaction();
    });

    expect(seen).not.toBeNull();
    expect(inTransaction).toBe(true);
  });

  test('a committed callback keeps its writes and returns its value', async () => {
    const userId = new mongoose.Types.ObjectId();

    const result = await withCreditTransaction(async (session) => {
      await CourseModel.create([makeCoursePayload(userId, 'tx-commit')], {
        session: session ?? undefined,
      });
      return 'returned-value';
    });

    expect(result).toBe('returned-value');
    expect(await CourseModel.countDocuments({ userId })).toBe(1);
  });

  test('a THROWING callback rolls its writes back — nothing is left behind', async () => {
    const userId = new mongoose.Types.ObjectId();

    await expect(
      withCreditTransaction(async (session) => {
        await CourseModel.create([makeCoursePayload(userId, 'tx-rollback-a')], {
          session: session ?? undefined,
        });
        await CourseModel.create([makeCoursePayload(userId, 'tx-rollback-b')], {
          session: session ?? undefined,
        });
        throw new Error('second write decided against it');
      }),
    ).rejects.toThrow('second write decided against it');

    // Under the non-transactional branch both rows would survive. This is the
    // assertion the whole phase turns on.
    expect(await CourseModel.countDocuments({ userId })).toBe(0);
  });

  test('the ORIGINAL error object is re-thrown, not a wrapper around it', async () => {
    // `dbTransaction.ts:49-58` captures the error and rethrows it deliberately,
    // so callers can branch on `instanceof` / `errorCode`. A wrapper here would
    // break `isDuplicateKeyError` checks at the Stripe webhook call sites.
    class LedgerWriteError extends Error {
      code = 11000;
    }
    const sentinel = new LedgerWriteError('E11000 duplicate key');

    await expect(
      withCreditTransaction(async () => {
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
  });

  test('endSession runs on the throwing path too — the finally block, pinned', async () => {
    const { box, spy } = captureSession();
    try {
      await expect(
        withCreditTransaction(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(box.session).not.toBeNull();
      // Real state, not a call count: a leaked session is a leaked server-side
      // resource on every failed debit.
      expect(box.session!.hasEnded).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('endSession runs on the happy path too', async () => {
    const { box, spy } = captureSession();
    try {
      await withCreditTransaction(async () => undefined);
      expect(box.session).not.toBeNull();
      expect(box.session!.hasEnded).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('writes are invisible to a reader OUTSIDE the transaction until it commits', async () => {
    const userId = new mongoose.Types.ObjectId();
    let visibleMidFlight = -1;

    await withCreditTransaction(async (session) => {
      await CourseModel.create([makeCoursePayload(userId, 'tx-isolation')], {
        session: session ?? undefined,
      });
      // Same connection, no session → must not see the uncommitted write.
      visibleMidFlight = await CourseModel.countDocuments({ userId });
    });

    expect(visibleMidFlight).toBe(0);
    expect(await CourseModel.countDocuments({ userId })).toBe(1);
  });
});
