/**
 * `recallRoutes` wiring, over REAL HTTP against the REAL router.
 *
 * The production bug this file exists to prevent is asymmetric, and the
 * dangerous half is the one that *adds* a gate:
 *
 *   - `requireCredits()` belongs on `POST /:recallCardId/grade` only, because
 *     grading a typed answer costs an LLM call. Rating, skipping and mode
 *     switching cost nothing. Widen the gate — e.g. by moving it onto the
 *     `router.use` line — and every free-tier user at zero balance is locked
 *     out of their own spaced-review queue. Retrieval practice is the
 *     product's retention loop; silently paywalling it churns users without
 *     producing a single error anyone sees.
 *   - The mirror bug: the gate removed from `/grade`, which turns a metered
 *     LLM call into an unmetered one.
 *
 * Also pinned: the router-wide `protect → requireVerified` gate, and that the
 * static `/queue`, `/stats`, `/due-count` resolve to their own handlers
 * rather than being captured as a `:recallCardId`.
 *
 * Method: `@controlers/recall` is replaced with 204 sentinels that record
 * which controller was reached. The middleware chain is real.
 *
 * Run: yarn test recallRoutes.wiring
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
// Imported statically (not via `await import()` inside the factory): a
// dynamic relative import needs an explicit extension under NodeNext and
// `yarn tsc` rejects it. This module is evaluated before the router import
// below, so the lazy `vi.mock` factory sees it initialised.
import { sentinelControllers } from '../../test-helpers/routeSentinels';
import mongoose from 'mongoose';

const log = vi.hoisted(() => ({ hits: [] as string[] }));

vi.mock('@controlers/recall', () => sentinelControllers(log, [
  'getRecallQueueController',
  'rateRecallController',
  'skipRecallController',
  'setRecallModeController',
  'getRecallStatsController',
  'getRecallDueCountController',
  'gradeRecallAnswerController',
  ]));

import { recallRoutes } from '@routes/recallRoutes';
import { protect, requireVerified } from '@middleware/authMiddleware';
import { usageContextMiddleware } from '@middleware/usageContext';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, UserModel } from '../../test-helpers/factories';
import { makeTestApp } from '../../test-helpers/app';
import { startTestServer, authHeaderFor, req as httpFor, type TestServer } from '../../test-helpers/http';

setupTestDb();

const OID = () => new mongoose.Types.ObjectId().toString();

let app: Express;
let server: TestServer;
let http: ReturnType<typeof httpFor>;

const zeroBalanceUser = async () => {
  const now = new Date();
  return makeUser({
    emailVerified: true,
    credits: {
      allowanceBalance: 0,
      allowanceGranted: 0,
      bonusBalance: 0,
      periodStart: now,
      // Future, so `getBalance` does not reset the period and hand out credits.
      periodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    },
  });
};

const fundedUser = async () => {
  const user = await makeUser({ emailVerified: true });
  const row = await UserModel.findById(user._id).select('credits').lean();
  expect((row?.credits.allowanceBalance ?? 0) + (row?.credits.bonusBalance ?? 0)).toBeGreaterThan(0);
  return user;
};

beforeAll(async () => {
  app = makeTestApp({ mount: { '/api/recall': recallRoutes } });
  server = await startTestServer(app);
  http = httpFor(server.base);
});

beforeEach(() => {
  log.hits.length = 0;
});

afterAll(async () => {
  await server.close();
});

const STATIC_GETS = [
  { path: '/queue', controller: 'getRecallQueueController' },
  { path: '/stats', controller: 'getRecallStatsController' },
  { path: '/due-count', controller: 'getRecallDueCountController' },
] as const;

/** Every parameterised action, and whether it is credit-gated. */
const CARD_ACTIONS = [
  { suffix: 'rate', controller: 'rateRecallController', metered: false },
  { suffix: 'skip', controller: 'skipRecallController', metered: false },
  { suffix: 'mode', controller: 'setRecallModeController', metered: false },
  { suffix: 'grade', controller: 'gradeRecallAnswerController', metered: true },
] as const;

describe('recallRoutes — the router-wide gate', () => {
  test.each(STATIC_GETS)('GET $path 401s with no Authorization header', async ({ path }) => {
    const res = await http.get(`/api/recall${path}`);
    expect(res.status).toBe(401);
    expect(log.hits).toEqual([]);
  });

  test.each(CARD_ACTIONS)('POST /:recallCardId/$suffix 401s with no Authorization header', async ({ suffix }) => {
    const res = await http.post(`/api/recall/${OID()}/${suffix}`, { body: {} });
    expect(res.status).toBe(401);
    expect(log.hits).toEqual([]);
  });

  test('an UNVERIFIED credentials user gets 403 EMAIL_NOT_VERIFIED, not 401', async () => {
    const user = await makeUser({ emailVerified: false });
    const res = await http.get('/api/recall/queue', { headers: authHeaderFor(user) });
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
    expect(res.json?.errorCode).toBe('EMAIL_NOT_VERIFIED');
  });

  test('the gate layers sit before every route, in order protect → requireVerified → usageContext', () => {
    const stack = (recallRoutes as unknown as { stack: { route?: unknown; handle: unknown }[] }).stack;
    const firstRouteIdx = stack.findIndex((l) => l.route);
    const idx = (fn: unknown) => stack.findIndex((l) => !l.route && l.handle === fn);
    expect(idx(protect)).toBeGreaterThanOrEqual(0);
    expect(idx(protect)).toBeLessThan(idx(requireVerified));
    expect(idx(requireVerified)).toBeLessThan(idx(usageContextMiddleware));
    expect(idx(usageContextMiddleware)).toBeLessThan(firstRouteIdx);
  });
});

describe('recallRoutes — static paths are not captured as :recallCardId', () => {
  test.each(STATIC_GETS)('GET $path resolves to $controller', async ({ path, controller }) => {
    const user = await fundedUser();
    const res = await http.get(`/api/recall${path}`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual([controller]);
  });

  test('harness sanity: POST /:recallCardId/rate resolves to the parameterised handler', async () => {
    const user = await fundedUser();
    const res = await http.post(`/api/recall/${OID()}/rate`, { headers: authHeaderFor(user), body: {} });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['rateRecallController']);
  });
});

describe('recallRoutes — requireCredits() is on /grade and NOWHERE else', () => {
  test('POST /:recallCardId/grade at zero balance → 402 INSUFFICIENT_CREDITS', async () => {
    const user = await zeroBalanceUser();
    const res = await http.post(`/api/recall/${OID()}/grade`, { headers: authHeaderFor(user), body: {} });
    expect(res.status).toBe(402);
    expect(res.json?.errorCode).toBe('INSUFFICIENT_CREDITS');
    expect(res.json?.meta).toMatchObject({ need: 1, have: 0 });
    expect(log.hits).toEqual([]);
  });

  test.each(CARD_ACTIONS.filter((a) => !a.metered))(
    'POST /:recallCardId/$suffix must NOT 402 at zero balance — the review queue stays free',
    async ({ suffix, controller }) => {
      const user = await zeroBalanceUser();
      const res = await http.post(`/api/recall/${OID()}/${suffix}`, { headers: authHeaderFor(user), body: {} });
      expect(res.status).toBe(204);
      expect(res.status).not.toBe(402);
      expect(log.hits).toEqual([controller]);
    },
  );

  test.each(STATIC_GETS)('GET $path must NOT 402 at zero balance', async ({ path, controller }) => {
    const user = await zeroBalanceUser();
    const res = await http.get(`/api/recall${path}`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(res.status).not.toBe(402);
    expect(log.hits).toEqual([controller]);
  });

  test('POST /:recallCardId/grade with a funded balance reaches the controller', async () => {
    const user = await fundedUser();
    const res = await http.post(`/api/recall/${OID()}/grade`, { headers: authHeaderFor(user), body: {} });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['gradeRecallAnswerController']);
  });
});

describe('recallRoutes — registration shape', () => {
  test('the tables cover every route the router registers', () => {
    const stack = (recallRoutes as unknown as {
      stack: { route?: { path: string; methods: Record<string, boolean> } }[];
    }).stack;
    const registered = stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path}`))
      .sort();
    const covered = [
      ...STATIC_GETS.map((r) => `get ${r.path}`),
      ...CARD_ACTIONS.map((a) => `post /:recallCardId/${a.suffix}`),
    ].sort();
    expect(registered).toEqual(covered);
  });
});
