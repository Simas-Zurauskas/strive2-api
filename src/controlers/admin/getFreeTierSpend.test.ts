/**
 * Tests for GET /api/admin/metrics/free-tier-spend.
 *
 * This endpoint is the cost control that makes the 2026-09-02 onboarding
 * grant (pricingConfig KNOB 9) safe to ship: it raises the free tier from
 * ~2 lessons to ~5, and without a way to read free-plan spend the first
 * signal of a runaway would be the provider invoice weeks later.
 *
 * The two properties worth pinning are both about NOT lying:
 *   - `UsageEvent.chargedMicroCents` is optional, and the model prescribes
 *     falling back to `costMicroCents` when it is absent. A naive `$sum` on a
 *     missing field contributes 0 and silently under-reports.
 *   - `UsageEvent.planAtTime` is absent for rows recorded outside an
 *     authenticated/job scope and for legacy rows. Those must be surfaced as
 *     `unattributedEvents`, not quietly dropped from the denominator.
 *
 * Run: yarn test getFreeTierSpend
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import UsageEventModel from '@models/UsageEventModel';
import mongoose from 'mongoose';
import {
  computeFreeTierSpend,
  freeTierSpendQuerySchema,
  getFreeTierSpendController,
} from './getFreeTierSpend';
import { buildReqRes, invokeController } from '../../../test-helpers/express';

setupTestDb();

const USD = 1_000_000; // 1,000,000 microcent units === $1

const seed = async (rows: Array<Record<string, unknown>>) => {
  await UsageEventModel.insertMany(
    rows.map((r) => ({
      userId: new mongoose.Types.ObjectId(),
      timestamp: new Date(),
      service: 'anthropic',
      action: 'lesson:content',
      costMicroCents: 0,
      ...r,
    })),
  );
};

beforeEach(async () => {
  await UsageEventModel.deleteMany({});
});

describe('computeFreeTierSpend', () => {
  test('empty window returns zeros, not null or NaN', async () => {
    const out = await computeFreeTierSpend({ days: 30 });
    expect(out).toMatchObject({
      windowDays: 30,
      vendorUsd: 0,
      chargedUsd: 0,
      events: 0,
      users: 0,
      unattributedEvents: 0,
    });
    expect(Number.isNaN(out.vendorUsd)).toBe(false);
  });

  test('converts microcent units to USD at 1e6, not 1e8', async () => {
    await seed([{ planAtTime: 'free', costMicroCents: 151_000, chargedMicroCents: 558_000 }]);
    const out = await computeFreeTierSpend({ days: 30 });
    // One real lesson: $0.151 vendor against $0.558 charged.
    expect(out.vendorUsd).toBeCloseTo(151_000 / USD, 6);
    expect(out.chargedUsd).toBeCloseTo(558_000 / USD, 6);
    expect(out.events).toBe(1);
  });

  test('a row missing chargedMicroCents falls back to costMicroCents', async () => {
    // The model documents this fallback; a bare $sum would contribute 0 and
    // make charged look smaller than vendor, which is impossible in reality.
    await seed([{ planAtTime: 'free', costMicroCents: 200_000 }]);
    const out = await computeFreeTierSpend({ days: 30 });
    expect(out.chargedUsd).toBeCloseTo(200_000 / USD, 6);
    expect(out.chargedUsd).toBeGreaterThanOrEqual(out.vendorUsd);
  });

  test('paid-plan rows are excluded from the free totals', async () => {
    await seed([
      { planAtTime: 'free', costMicroCents: 100_000 },
      { planAtTime: 'pro', costMicroCents: 900_000 },
    ]);
    const out = await computeFreeTierSpend({ days: 30 });
    expect(out.vendorUsd).toBeCloseTo(100_000 / USD, 6);
    expect(out.events).toBe(1);
  });

  test('rows with no planAtTime are counted as unattributed, never silently dropped', async () => {
    await seed([
      { planAtTime: 'free', costMicroCents: 100_000 },
      { costMicroCents: 500_000 }, // legacy / out-of-scope row
      { costMicroCents: 250_000 },
    ]);
    const out = await computeFreeTierSpend({ days: 30 });
    expect(out.events).toBe(1);
    expect(out.unattributedEvents).toBe(2);
    expect(out.vendorUsd).toBeCloseTo(100_000 / USD, 6);
  });

  test('counts distinct users, not events', async () => {
    const shared = new mongoose.Types.ObjectId();
    await seed([
      { planAtTime: 'free', userId: shared, costMicroCents: 10_000 },
      { planAtTime: 'free', userId: shared, costMicroCents: 10_000 },
      { planAtTime: 'free', costMicroCents: 10_000 },
    ]);
    const out = await computeFreeTierSpend({ days: 30 });
    expect(out.events).toBe(3);
    expect(out.users).toBe(2);
  });

  test('rows outside the window are excluded', async () => {
    const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    await seed([
      { planAtTime: 'free', costMicroCents: 100_000 },
      { planAtTime: 'free', costMicroCents: 700_000, timestamp: longAgo },
    ]);
    const out = await computeFreeTierSpend({ days: 30 });
    expect(out.events).toBe(1);
    expect(out.vendorUsd).toBeCloseTo(100_000 / USD, 6);
  });
});

// ── Query validation (conformance finding F2) ───────────────
//
// The tests above call `computeFreeTierSpend` directly, so nothing exercised
// the request-facing boundary. `days` is the only user-supplied input on this
// endpoint and it flows straight into a date computation, so it needs checks
// that can actually fail — verified by hand during the end-to-end walk
// (0/400/abc each returned 400), but unpinned until now.

describe('freeTierSpendQuerySchema', () => {
  test('defaults to a 30-day window when days is omitted', () => {
    expect(freeTierSpendQuerySchema.parse({})).toEqual({ days: 30 });
  });

  test('accepts the inclusive bounds', () => {
    expect(freeTierSpendQuerySchema.parse({ days: '1' }).days).toBe(1);
    expect(freeTierSpendQuerySchema.parse({ days: '365' }).days).toBe(365);
  });

  // Split by WHICH check does the rejecting, because the two groups protect
  // different things and only the first would notice if `.min(1).max(365)`
  // were deleted. `''` belongs in the bounds group, not the type group:
  // Number('') is 0, not NaN, so it survives coercion and is caught by min.
  test.each(['0', '-5', '366', ''])('rejects days=%s via the bounds', (bad) => {
    expect(() => freeTierSpendQuerySchema.parse({ days: bad })).toThrow();
  });

  test.each(['abc', '1.5'])('rejects days=%s via coercion/int, independent of bounds', (bad) => {
    expect(() => freeTierSpendQuerySchema.parse({ days: bad })).toThrow();
  });
});

// ── The controller itself ───────────────────────────────────
//
// Everything above tests the two halves in isolation. Nothing exercised the
// wiring — `adminRoutes.test.ts` mocks this controller wholesale, so the path
// query -> schema -> compute -> res.json had no coverage at all and could
// have been mis-wired (wrong field read off `req`, result not serialised,
// validation not actually applied) with the whole suite still green.

describe('getFreeTierSpendController', () => {
  test('parses the query, aggregates, and serialises the result', async () => {
    await seed([{ planAtTime: 'free', costMicroCents: 300_000, chargedMicroCents: 900_000 }]);
    const { req, res, json } = buildReqRes({ query: { days: '30' } });
    await invokeController(getFreeTierSpendController, req, res);

    const payload = json.mock.calls[0][0] as Record<string, number>;
    expect(payload).toMatchObject({ windowDays: 30, events: 1, users: 1, unattributedEvents: 0 });
    expect(payload.vendorUsd).toBeCloseTo(0.3, 6);
    expect(payload.chargedUsd).toBeCloseTo(0.9, 6);
  });

  test('applies the schema default when days is absent', async () => {
    const { req, res, json } = buildReqRes({ query: {} });
    await invokeController(getFreeTierSpendController, req, res);
    expect((json.mock.calls[0][0] as { windowDays: number }).windowDays).toBe(30);
  });

  test('honours a caller-supplied window rather than always using 30', async () => {
    const { req, res, json } = buildReqRes({ query: { days: '7' } });
    await invokeController(getFreeTierSpendController, req, res);
    expect((json.mock.calls[0][0] as { windowDays: number }).windowDays).toBe(7);
  });

  test('rejects an out-of-range window instead of silently clamping', async () => {
    const { req, res } = buildReqRes({ query: { days: '9999' } });
    await expect(invokeController(getFreeTierSpendController, req, res)).rejects.toThrow();
  });

  test('rejects a non-numeric window', async () => {
    const { req, res } = buildReqRes({ query: { days: 'abc' } });
    await expect(invokeController(getFreeTierSpendController, req, res)).rejects.toThrow();
  });
});
