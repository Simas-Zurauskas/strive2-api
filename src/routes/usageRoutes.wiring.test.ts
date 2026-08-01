/**
 * `usageRoutes` wiring, over REAL HTTP against the REAL router — the SECOND
 * `requireAdmin` surface in the codebase (`usageRoutes.ts:18`), and the one
 * that is easy to forget when the first is fixed.
 *
 * The production bug this file exists to prevent: `requireAdmin` dropped from
 * `router.use(protect, requireVerified, requireAdmin, usageContextMiddleware)`.
 * These routes expose raw per-call vendor spend in microcents — i.e. our unit
 * economics, per user, per model — to anyone with a session. `DELETE /events`
 * is worse still: it wipes ledger rows, and the ledger is the audit trail the
 * credit system reconciles against. There is no undo.
 *
 * As in `adminRoutes.test.ts`, every 403 case also asserts NOT 401, because a
 * 401 trips the client's auto-sign-out interceptor and evicts a legitimately
 * signed-in non-admin for touching an ops URL.
 *
 * Run: yarn test usageRoutes.wiring
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
// Imported statically (not via `await import()` inside the factory): a
// dynamic relative import needs an explicit extension under NodeNext and
// `yarn tsc` rejects it. This module is evaluated before the router import
// below, so the lazy `vi.mock` factory sees it initialised.
import { sentinelControllers } from '../../test-helpers/routeSentinels';

const log = vi.hoisted(() => ({ hits: [] as string[] }));

vi.mock('@controlers/usage', () => sentinelControllers(log, [
  'getUsageHistoryController',
  'getUsageSummaryController',
  'deleteUsageEventsController',
  ]));

import { usageRoutes } from '@routes/usageRoutes';
import { protect, requireAdmin, requireVerified } from '@middleware/authMiddleware';
import { usageContextMiddleware } from '@middleware/usageContext';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, UserModel } from '../../test-helpers/factories';
import { makeTestApp } from '../../test-helpers/app';
import { startTestServer, authHeaderFor, req as httpFor, type TestServer } from '../../test-helpers/http';

setupTestDb();

const ROUTES = [
  { method: 'get', path: '/history', controller: 'getUsageHistoryController' },
  { method: 'get', path: '/summary', controller: 'getUsageSummaryController' },
  { method: 'delete', path: '/events', controller: 'deleteUsageEventsController' },
] as const;

let app: Express;
let server: TestServer;
let http: ReturnType<typeof httpFor>;

const send = (route: (typeof ROUTES)[number], headers?: Record<string, string>) =>
  route.method === 'get'
    ? http.get(`/api/usage${route.path}`, { headers })
    : http.del(`/api/usage${route.path}`, { headers });

beforeAll(async () => {
  app = makeTestApp({ mount: { '/api/usage': usageRoutes } });
  server = await startTestServer(app);
  http = httpFor(server.base);
});

beforeEach(() => {
  log.hits.length = 0;
});

afterAll(async () => {
  await server.close();
});

describe('usageRoutes — the admin gate chain', () => {
  test.each(ROUTES)('$method $path 401s with no Authorization header', async (route) => {
    const res = await send(route);
    expect(res.status).toBe(401);
    expect(log.hits).toEqual([]);
  });

  test.each(ROUTES)('$method $path — a verified NON-ADMIN is refused with 403 and is NOT signed out (401)', async (route) => {
    const user = await makeUser({ emailVerified: true, isAdmin: false });
    const res = await send(route, authHeaderFor(user));
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
    expect(res.json?.message).toMatch(/admin access required/i);
    expect(log.hits).toEqual([]);
  });

  test.each(ROUTES)('$method $path — an UNVERIFIED admin is stopped by requireVerified FIRST (403 EMAIL_NOT_VERIFIED)', async (route) => {
    const user = await makeUser({ emailVerified: false, isAdmin: true });
    const res = await send(route, authHeaderFor(user));
    expect(res.status).toBe(403);
    expect(res.json?.errorCode).toBe('EMAIL_NOT_VERIFIED');
    expect(log.hits).toEqual([]);
  });

  test.each(ROUTES)('$method $path — a verified ADMIN passes the gate', async (route) => {
    const user = await makeUser({ emailVerified: true, isAdmin: true });
    const res = await send(route, authHeaderFor(user));
    expect(res.status).toBe(204);
    expect(log.hits).toEqual([route.controller]);
  });

  test('an admin with a stale tokenVersion is refused with 401 (session genuinely revoked)', async () => {
    const user = await makeUser({ emailVerified: true, isAdmin: true, tokenVersion: 0 });
    const header = authHeaderFor(user);
    await UserModel.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    const res = await send(ROUTES[2], header);
    expect(res.status).toBe(401);
    expect(log.hits).toEqual([]);
  });
});

describe('usageRoutes — registration shape', () => {
  const stack = (usageRoutes as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean> }; handle: unknown }[];
  }).stack;

  test('the gate order is protect → requireVerified → requireAdmin → usageContext, all before every route', () => {
    const firstRouteIdx = stack.findIndex((l) => l.route);
    const idx = (fn: unknown) => stack.findIndex((l) => !l.route && l.handle === fn);
    expect(idx(protect)).toBeGreaterThanOrEqual(0);
    expect(idx(protect)).toBeLessThan(idx(requireVerified));
    expect(idx(requireVerified)).toBeLessThan(idx(requireAdmin));
    expect(idx(requireAdmin)).toBeLessThan(idx(usageContextMiddleware));
    expect(idx(usageContextMiddleware)).toBeLessThan(firstRouteIdx);
  });

  test('the route table covers every route the router registers', () => {
    const registered = stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path}`))
      .sort();
    expect(registered).toEqual(ROUTES.map((r) => `${r.method} ${r.path}`).sort());
  });
});
