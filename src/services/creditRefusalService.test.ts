/**
 * Tests for `recordCreditRefusal` — the REAL service against a real Mongo,
 * not the mock the middleware suite uses.
 *
 * This file exists because its absence let a live defect ship to the
 * end-to-end walk: `mongoose.model()` was called without an explicit
 * collection name, so rows landed in `creditrefusals` while every other
 * collection in this database is PascalCase singular. Nothing in the unit
 * suite could see it, because the only test that touched this code path
 * mocked the whole service away.
 *
 * The properties pinned here are the ones the middleware's own tests
 * structurally cannot reach:
 *   - the row is written, to the CORRECT collection;
 *   - truncation happens in code, so an over-long path is stored rather than
 *     rejected by a validator;
 *   - the function never throws and never rejects, whatever Mongo does;
 *   - a malformed userId is reported, not silently dropped.
 *
 * Run: yarn test creditRefusalService
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import CreditRefusalModel, { CREDIT_REFUSAL_PATH_MAX } from '@models/CreditRefusalModel';

const { fakeBgError } = vi.hoisted(() => ({ fakeBgError: vi.fn() }));
vi.mock('@lib/bg', () => ({
  bgError: (context: string) => (err: unknown) => fakeBgError(context, err),
}));

import { recordCreditRefusal } from '@services/creditRefusalService';

setupTestDb();

const USER = '507f1f77bcf86cd799439011';

/**
 * The write is fire-and-forget, so tests must wait for it to land. Poll for
 * the expected row count rather than sleeping a fixed interval: a fixed sleep
 * is a coin-flip under full-suite parallel load — it passed in isolation and
 * flaked once in the whole run, which is precisely the failure mode that
 * teaches people to re-run CI instead of trusting it.
 */
const waitForRows = async (expected: number, timeoutMs = 3000): Promise<number> => {
  const deadline = Date.now() + timeoutMs;
  let n = await CreditRefusalModel.countDocuments();
  while (n !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    n = await CreditRefusalModel.countDocuments();
  }
  return n;
};

/**
 * For the negative cases ("no row must be written"), there is no state change
 * to poll for, so give the write a bounded chance to land and then assert it
 * did not. Polling for bgError keeps it deterministic where possible.
 */
const waitForBgError = async (timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (fakeBgError.mock.calls.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(async () => {
  // Drain BEFORE clearing: a fire-and-forget write started by the previous
  // test can otherwise land after this cleanup and be counted by the next one.
  await new Promise((r) => setTimeout(r, 25));
  await CreditRefusalModel.deleteMany({});
  fakeBgError.mockReset();
});

describe('recordCreditRefusal', () => {
  test('writes one row with the refusal detail', async () => {
    recordCreditRefusal({ userId: USER, plan: 'free', path: 'POST /api/course', need: 1, have: 0 });
    expect(await waitForRows(1)).toBe(1);

    const rows = await CreditRefusalModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plan: 'free', path: 'POST /api/course', need: 1, have: 0 });
    expect(String(rows[0].userId)).toBe(USER);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    expect(fakeBgError).not.toHaveBeenCalled();
  });

  test('lands in the `CreditRefusal` collection, not mongoose-pluralised `creditrefusals`', async () => {
    // The exact defect this file was written for. Every other collection in
    // this database is PascalCase singular; a default-pluralised name would
    // be invisible to every dashboard and query that follows the convention.
    recordCreditRefusal({ userId: USER, plan: 'free', path: 'POST /x', need: 1, have: 0 });
    expect(await waitForRows(1)).toBe(1);

    expect(CreditRefusalModel.collection.collectionName).toBe('CreditRefusal');
    const direct = await mongoose.connection.db!.collection('CreditRefusal').countDocuments();
    expect(direct).toBe(1);
    const pluralised = await mongoose.connection.db!.collection('creditrefusals').countDocuments();
    expect(pluralised).toBe(0);
  });

  test('an over-long path is TRUNCATED and stored, never rejected', async () => {
    // Truncating in code rather than via a `maxlength` validator is what makes
    // this survivable: the write is error-swallowed, so a validator rejection
    // would silently discard the longest and most anomalous URLs — exactly the
    // ones worth seeing.
    const long = `/api/course/${'x'.repeat(2000)}`;
    recordCreditRefusal({ userId: USER, plan: 'pro', path: long, need: 1, have: 0 });
    expect(await waitForRows(1)).toBe(1);

    const rows = await CreditRefusalModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toHaveLength(CREDIT_REFUSAL_PATH_MAX);
    expect(long.startsWith(rows[0].path)).toBe(true);
  });

  test('a malformed userId is REPORTED, not silently dropped', async () => {
    recordCreditRefusal({ userId: 'not-an-objectid', plan: 'free', path: 'POST /x', need: 1, have: 0 });
    await waitForBgError();

    expect(await CreditRefusalModel.countDocuments()).toBe(0);
    expect(fakeBgError).toHaveBeenCalledOnce();
    expect(fakeBgError.mock.calls[0][0]).toBe('creditRefusal.record');
  });

  test('never throws synchronously, even when the model itself blows up', async () => {
    // The middleware calls this on a request-blocking path. A synchronous
    // throw here would convert a 402 into a 500.
    const spy = vi.spyOn(CreditRefusalModel, 'create').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() =>
      recordCreditRefusal({ userId: USER, plan: 'free', path: 'POST /x', need: 1, have: 0 }),
    ).not.toThrow();
    await waitForBgError();
    expect(fakeBgError).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test('never rejects when the write fails asynchronously', async () => {
    const spy = vi
      .spyOn(CreditRefusalModel, 'create')
      .mockRejectedValue(new Error('mongo down') as never);
    recordCreditRefusal({ userId: USER, plan: 'free', path: 'POST /x', need: 1, have: 0 });
    await waitForBgError();

    expect(await CreditRefusalModel.countDocuments()).toBe(0);
    expect(fakeBgError).toHaveBeenCalledOnce();
    expect(fakeBgError.mock.calls[0][0]).toBe('creditRefusal.record');
    spy.mockRestore();
  });

  test('fractional balances are preserved (the gate admits < 1, not just 0)', async () => {
    recordCreditRefusal({ userId: USER, plan: 'free', path: 'POST /x', need: 1, have: 0.5 });
    expect(await waitForRows(1)).toBe(1);
    const rows = await CreditRefusalModel.find({}).lean();
    expect(rows[0].have).toBe(0.5);
  });

  test('declares a TTL index so rows self-purge', async () => {
    const idx = await CreditRefusalModel.collection.indexes();
    const ttl = idx.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl?.expireAfterSeconds).toBeGreaterThan(0);
  });
});
