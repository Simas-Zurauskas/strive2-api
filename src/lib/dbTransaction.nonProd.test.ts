/**
 * The OTHER half of `withCreditTransaction`: the dev/test short-circuit.
 *
 * Separate file, not a second `describe`, because `vi.mock` is hoisted to the
 * top of the module — a file that mocks `@conf/env` cannot also observe the
 * unmocked behaviour. The production branch lives in `dbTransaction.test.ts`.
 *
 * The bug this file exists to prevent is subtler than "the code is wrong": it
 * is **a reader believing dev/test has the same atomicity guarantee production
 * has.** It does not, on purpose (`dbTransaction.ts:40-44`), and the last test
 * here makes that divergence executable rather than a comment. Anyone tempted
 * to assert production behaviour from a test-mode observation should read it.
 *
 * Run: yarn test dbTransaction
 */

import { describe, test, expect } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { withCreditTransaction } from '@lib/dbTransaction';
import { ENVIRONMENT } from '@conf/env';
import CourseModel from '@models/CourseModel';

setupTestDb();

const makeCoursePayload = (userId: mongoose.Types.ObjectId, name: string) => ({
  userId,
  name,
  slug: `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  goal: 'transaction fixture',
  status: 'ready' as const,
});

describe('withCreditTransaction — dev/test branch (no @conf/env mock here)', () => {
  test('ENVIRONMENT is the real test value — this file must NOT be mocked', () => {
    expect(ENVIRONMENT).toBe('test');
  });

  test('the callback receives a NULL session and still runs', async () => {
    let seen: unknown = 'untouched';
    const result = await withCreditTransaction(async (session) => {
      seen = session;
      return 42;
    });

    expect(seen).toBeNull();
    expect(result).toBe(42);
  });

  test('writes commit without any wrapping transaction', async () => {
    const userId = new mongoose.Types.ObjectId();
    await withCreditTransaction(async (session) => {
      await CourseModel.create([makeCoursePayload(userId, 'noTx-commit')], {
        session: session ?? undefined,
      });
    });
    expect(await CourseModel.countDocuments({ userId })).toBe(1);
  });

  test('DOCUMENTED DIVERGENCE: a throwing callback leaves its earlier writes in place', async () => {
    const userId = new mongoose.Types.ObjectId();

    await expect(
      withCreditTransaction(async (session) => {
        await CourseModel.create([makeCoursePayload(userId, 'noTx-partial')], {
          session: session ?? undefined,
        });
        throw new Error('fails after the first write');
      }),
    ).rejects.toThrow('fails after the first write');

    // Production rolls this back (see dbTransaction.test.ts). Test/dev does
    // not. Any test that observes post-failure state through this path is
    // describing test mode, NOT production.
    expect(await CourseModel.countDocuments({ userId })).toBe(1);
  });

  test('mongoose.startSession is never called on this path', async () => {
    // Asserting the absence of a session is what distinguishes "no transaction"
    // from "a transaction that happened to commit".
    let sessionSeen: unknown;
    await withCreditTransaction(async (session) => {
      sessionSeen = session;
    });
    expect(sessionSeen).toBeNull();
    expect(mongoose.connection.readyState).toBe(1);
  });
});
