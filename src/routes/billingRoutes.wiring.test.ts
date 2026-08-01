/**
 * `billingRoutes` gate wiring, over REAL HTTP against the REAL router.
 *
 * This router is the canonical instance of the "public routes must be
 * registered BEFORE `router.use(protect)`" rule: `GET /plans` sits on line 19
 * and `router.use(protect)` on line 25. The production bug this file exists
 * to prevent is someone moving `/plans` below that line — after which the
 * public pricing page 401s for every anonymous visitor, the marketing site
 * shows no prices, and (worse) the 401 trips the client's auto-sign-out
 * interceptor for anyone who happens to be signed in on another tab. The
 * mistake is invisible in review because the diff is a moved line.
 *
 * The mirror bug: `requireVerified` added to this router. Billing is
 * deliberately reachable by an unverified user — some people pay before they
 * verify — so a gate here silently blocks revenue.
 *
 * Method: `@controlers/billing` is replaced with 204 sentinels so nothing
 * reaches Stripe.
 *
 * Run: yarn test billingRoutes.wiring
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
// Imported statically (not via `await import()` inside the factory): a
// dynamic relative import needs an explicit extension under NodeNext and
// `yarn tsc` rejects it. This module is evaluated before the router import
// below, so the lazy `vi.mock` factory sees it initialised.
import { sentinelControllers } from '../../test-helpers/routeSentinels';

const log = vi.hoisted(() => ({ hits: [] as string[] }));

vi.mock('@controlers/billing', () => sentinelControllers(log, [
  'startCheckoutController',
  'startTopupController',
  'startPortalController',
  'getBillingSummaryController',
  'getBillingLedgerController',
  'getBillingPlansController',
  'downgradeController',
  'cancelSubscriptionController',
  'stripeWebhookController',
  ]));

import { billingRoutes } from '@routes/billingRoutes';
import { protect } from '@middleware/authMiddleware';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser } from '../../test-helpers/factories';
import { makeTestApp } from '../../test-helpers/app';
import { startTestServer, authHeaderFor, req as httpFor, type TestServer } from '../../test-helpers/http';

setupTestDb();

type Method = 'get' | 'post';
interface RouteSpec {
  method: Method;
  path: string;
  controller: string;
}

const PUBLIC_ROUTES: RouteSpec[] = [
  { method: 'get', path: '/plans', controller: 'getBillingPlansController' },
];

const GATED_ROUTES: RouteSpec[] = [
  { method: 'post', path: '/checkout', controller: 'startCheckoutController' },
  { method: 'post', path: '/topup', controller: 'startTopupController' },
  { method: 'post', path: '/portal', controller: 'startPortalController' },
  { method: 'post', path: '/downgrade', controller: 'downgradeController' },
  { method: 'post', path: '/cancel', controller: 'cancelSubscriptionController' },
  { method: 'get', path: '/summary', controller: 'getBillingSummaryController' },
  { method: 'get', path: '/ledger', controller: 'getBillingLedgerController' },
];

let app: Express;
let server: TestServer;
let http: ReturnType<typeof httpFor>;

const send = (route: RouteSpec, headers?: Record<string, string>) =>
  route.method === 'get'
    ? http.get(`/api/billing${route.path}`, { headers })
    : http.post(`/api/billing${route.path}`, { headers, body: {} });

beforeAll(async () => {
  app = makeTestApp({ mount: { '/api/billing': billingRoutes } });
  server = await startTestServer(app);
  http = httpFor(server.base);
});

beforeEach(() => {
  log.hits.length = 0;
});

afterAll(async () => {
  await server.close();
});

describe('billingRoutes — the public/gated split', () => {
  test.each(PUBLIC_ROUTES)(
    '$method $path is PUBLIC — it is registered above `router.use(protect)` and must answer anonymously',
    async (route) => {
      const res = await send(route);
      expect(res.status).toBe(204);
      expect(res.status).not.toBe(401);
      expect(log.hits).toEqual([route.controller]);
    },
  );

  test.each(GATED_ROUTES)('$method $path 401s anonymously and never reaches its controller', async (route) => {
    const res = await send(route);
    expect(res.status).toBe(401);
    expect(log.hits).toEqual([]);
  });

  // Harness sanity, in the shape the plan asks for: the same file asserts a
  // 204 and a 401 on the SAME router, so a harness that answered one status
  // to everything could not report green.
  test('harness sanity: /plans (204) and /summary (401) disagree on the same router in the same run', async () => {
    const plans = await send(PUBLIC_ROUTES[0]);
    const summary = await send(GATED_ROUTES.find((r) => r.path === '/summary')!);
    expect(plans.status).toBe(204);
    expect(summary.status).toBe(401);
    expect(plans.status).not.toBe(summary.status);
  });
});

describe('billingRoutes — an unverified user can still pay', () => {
  test.each(GATED_ROUTES)('$method $path is reachable by an UNVERIFIED credentials user (no requireVerified here)', async (route) => {
    const user = await makeUser({ emailVerified: false });
    const res = await send(route, authHeaderFor(user));
    expect(res.status).toBe(204);
    expect(res.status).not.toBe(403);
    expect(log.hits).toEqual([route.controller]);
  });
});

describe('billingRoutes — registration shape', () => {
  const stack = (billingRoutes as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean> }; handle: unknown }[];
  }).stack;

  test('`/plans` is registered BEFORE the protect layer, every other route after it', () => {
    const protectIdx = stack.findIndex((l) => !l.route && l.handle === protect);
    expect(protectIdx).toBeGreaterThanOrEqual(0);

    const idxOf = (path: string) => stack.findIndex((l) => l.route?.path === path);
    for (const r of PUBLIC_ROUTES) expect(idxOf(r.path)).toBeLessThan(protectIdx);
    for (const r of GATED_ROUTES) expect(idxOf(r.path)).toBeGreaterThan(protectIdx);
  });

  test('the route tables cover every route the router registers', () => {
    const registered = stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path}`))
      .sort();
    const covered = [...PUBLIC_ROUTES, ...GATED_ROUTES].map((r) => `${r.method} ${r.path}`).sort();
    expect(registered).toEqual(covered);
  });
});
