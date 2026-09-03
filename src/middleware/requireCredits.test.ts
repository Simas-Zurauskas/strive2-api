/**
 * Tests for the requireCredits middleware. Boundary at balance >= 1 + the
 * defensive `req.userId` guard rail.
 *
 * Run: yarn test requireCredits
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('@services/creditService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/creditService')>();
  return {
    ...actual,
    getBalance: vi.fn(),
  };
});

vi.mock('@services/creditRefusalService', () => ({
  recordCreditRefusal: vi.fn(),
}));

import { requireCredits } from '@middleware/requireCredits';
import { getBalance, InsufficientCreditsError } from '@services/creditService';
import { recordCreditRefusal } from '@services/creditRefusalService';

const mockedGetBalance = vi.mocked(getBalance);
const mockedRecordRefusal = vi.mocked(recordCreditRefusal);

beforeEach(() => {
  mockedGetBalance.mockReset();
  mockedRecordRefusal.mockReset();
});

const buildReqRes = (overrides: { userId?: string } = {}) => {
  const req = { userId: overrides.userId, method: 'POST', originalUrl: '/test' } as unknown as Request;
  const res = {} as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
};

const runMiddleware = async (params: {
  req: Request;
  res: Response;
  next: NextFunction;
}) => {
  // express-async-handler returns a `(req, res, next) => Promise` — invoke it
  // and let any thrown error reject the promise so the test can catch it.
  const handler = requireCredits();
  return new Promise<void>((resolve, reject) => {
    const wrappedNext = ((err?: unknown) => {
      if (err) reject(err);
      else {
        (params.next as () => void)();
        resolve();
      }
    }) as NextFunction;
    Promise.resolve(handler(params.req, params.res, wrappedNext)).catch(reject);
  });
};

describe('requireCredits', () => {
  test('happy path: balance.total >= 1 → calls next()', async () => {
    mockedGetBalance.mockResolvedValueOnce({
      allowance: 5,
      bonus: 0,
      total: 5,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'free',
    });
    const { req, res, next } = buildReqRes({ userId: 'user-1' });
    await runMiddleware({ req, res, next });
    expect(next).toHaveBeenCalledOnce();
  });

  test('boundary: balance.total === 1 passes', async () => {
    mockedGetBalance.mockResolvedValueOnce({
      allowance: 1,
      bonus: 0,
      total: 1,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'free',
    });
    const { req, res, next } = buildReqRes({ userId: 'user-2' });
    await runMiddleware({ req, res, next });
    expect(next).toHaveBeenCalledOnce();
  });

  test('boundary: balance.total === 0 throws InsufficientCreditsError with meta', async () => {
    mockedGetBalance.mockResolvedValueOnce({
      allowance: 0,
      bonus: 0,
      total: 0,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'free',
    });
    const { req, res, next } = buildReqRes({ userId: 'user-3' });
    await expect(runMiddleware({ req, res, next })).rejects.toMatchObject({
      statusCode: 402,
      errorCode: 'INSUFFICIENT_CREDITS',
      meta: { need: 1, have: 0 },
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('fractional balance below 1 (e.g. 0.5) → 402 (treated as < 1)', async () => {
    mockedGetBalance.mockResolvedValueOnce({
      allowance: 0.5,
      bonus: 0,
      total: 0.5,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'free',
    });
    const { req, res, next } = buildReqRes({ userId: 'user-4' });
    await expect(runMiddleware({ req, res, next })).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  test('negative balance (defensive — should not happen) → 402', async () => {
    mockedGetBalance.mockResolvedValueOnce({
      allowance: -1,
      bonus: 0,
      total: -1,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'free',
    });
    const { req, res, next } = buildReqRes({ userId: 'user-5' });
    await expect(runMiddleware({ req, res, next })).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  test('missing req.userId (middleware ordering bug) → 401 Unauthorized', async () => {
    const { req, res, next } = buildReqRes({ userId: undefined });
    await expect(runMiddleware({ req, res, next })).rejects.toMatchObject({
      statusCode: 401,
      message: 'Unauthorized',
    });
    expect(mockedGetBalance).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('bonus-only credit also passes the gate (allowance + bonus = total)', async () => {
    mockedGetBalance.mockResolvedValueOnce({
      allowance: 0,
      bonus: 3,
      total: 3,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'free',
    });
    const { req, res, next } = buildReqRes({ userId: 'user-6' });
    await runMiddleware({ req, res, next });
    expect(next).toHaveBeenCalledOnce();
  });
});

// ── Durable refusal record (2026-09-02) ─────────────────────
//
// Before this, a credit refusal existed only as a `monetizationLog.info` line
// on stdout, so "how many users asked for something and were told no" had
// never been counted — leaving the central question (do users leave because
// they hit a wall, or because they lost interest?) unanswerable. These tests
// pin the three properties that make the record trustworthy: it is written,
// it cannot break the gate, and it cannot be used to smuggle unbounded data
// into the collection.

describe('requireCredits — durable refusal record', () => {
  test('a refusal writes exactly one CreditRefusal row carrying need/have/plan', async () => {
    mockedGetBalance.mockResolvedValueOnce({
      allowance: 0,
      bonus: 0,
      total: 0,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'free',
    });
    const { req, res, next } = buildReqRes({ userId: '507f1f77bcf86cd799439011' });
    await expect(runMiddleware({ req, res, next })).rejects.toMatchObject({ statusCode: 402 });

    expect(mockedRecordRefusal).toHaveBeenCalledOnce();
    expect(mockedRecordRefusal).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '507f1f77bcf86cd799439011', plan: 'free', need: 1, have: 0 }),
    );
  });

  test('a PASSING request writes no row', async () => {
    mockedGetBalance.mockResolvedValueOnce({
      allowance: 9,
      bonus: 0,
      total: 9,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'pro',
    });
    const { req, res, next } = buildReqRes({ userId: 'user-ok' });
    await runMiddleware({ req, res, next });
    expect(mockedRecordRefusal).not.toHaveBeenCalled();
  });

  test('a rejecting write still yields the 402 — observability cannot break the gate', async () => {
    mockedRecordRefusal.mockImplementationOnce(() => {
      throw new Error('mongo down');
    });
    mockedGetBalance.mockResolvedValueOnce({
      allowance: 0,
      bonus: 0,
      total: 0,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'free',
    });
    const { req, res, next } = buildReqRes({ userId: 'user-boom' });
    await expect(runMiddleware({ req, res, next })).rejects.toMatchObject({
      statusCode: 402,
      errorCode: 'INSUFFICIENT_CREDITS',
      meta: { need: 1, have: 0 },
    });
  });

  test('an over-long path is truncated to 512 chars before it is stored', async () => {
    // Truncation must happen in code, not via a Mongoose maxlength validator:
    // a validator would REJECT the insert, and since the write is deliberately
    // error-swallowed, the longest and most anomalous URLs — exactly the ones
    // worth seeing — would vanish silently.
    mockedGetBalance.mockResolvedValueOnce({
      allowance: 0,
      bonus: 0,
      total: 0,
      periodStart: new Date(),
      periodEnd: new Date(),
      plan: 'free',
    });
    const longUrl = `/api/course/${'x'.repeat(900)}`;
    const req = { userId: 'user-long', method: 'POST', originalUrl: longUrl } as unknown as Request;
    await expect(
      runMiddleware({ req, res: {} as Response, next: vi.fn() as NextFunction }),
    ).rejects.toMatchObject({ statusCode: 402 });

    // Stored shape is `METHOD /path` (see CreditRefusalModel.path), so the
    // prefix check runs against the composed string, not the bare URL.
    const storedPath = mockedRecordRefusal.mock.calls[0][0].path;
    expect(storedPath).toHaveLength(512);
    expect(`POST ${longUrl}`.startsWith(storedPath)).toBe(true);
    expect(storedPath.startsWith('POST /api/course/')).toBe(true);
  });
});
