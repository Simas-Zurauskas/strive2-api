/**
 * `gamificationRoutes` wiring, over REAL HTTP against the REAL router.
 *
 * The production bug this file exists to prevent: the router-wide
 * `router.use(protect, requireVerified, usageContextMiddleware)` dropped, or
 * a new route added above it. Every route here reads a *named individual's*
 * XP, streak, achievement and quiz-trend history — the personal-data surface
 * of the product. Ungated, all of it is enumerable by an anonymous caller.
 *
 * Small router, so this file is short by design: the value is that it exists
 * at all, and that the route table below fails when a fourth route is added
 * without a decision about its gate.
 *
 * Run: yarn test gamificationRoutes.wiring
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
// Imported statically (not via `await import()` inside the factory): a
// dynamic relative import needs an explicit extension under NodeNext and
// `yarn tsc` rejects it. This module is evaluated before the router import
// below, so the lazy `vi.mock` factory sees it initialised.
import { sentinelControllers } from '../../test-helpers/routeSentinels';

const log = vi.hoisted(() => ({ hits: [] as string[] }));

vi.mock('@controlers/gamification', () => sentinelControllers(log, ['getProfileController', 'getStatsController', 'getQuizTrendsController']));

import { gamificationRoutes } from '@routes/gamificationRoutes';
import { protect, requireVerified } from '@middleware/authMiddleware';
import { usageContextMiddleware } from '@middleware/usageContext';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser } from '../../test-helpers/factories';
import { makeTestApp } from '../../test-helpers/app';
import { startTestServer, authHeaderFor, req as httpFor, type TestServer } from '../../test-helpers/http';

setupTestDb();

const ROUTES = [
  { path: '/profile', controller: 'getProfileController' },
  { path: '/stats', controller: 'getStatsController' },
  { path: '/quiz-trends', controller: 'getQuizTrendsController' },
] as const;

let app: Express;
let server: TestServer;
let http: ReturnType<typeof httpFor>;

beforeAll(async () => {
  app = makeTestApp({ mount: { '/api/gamification': gamificationRoutes } });
  server = await startTestServer(app);
  http = httpFor(server.base);
});

beforeEach(() => {
  log.hits.length = 0;
});

afterAll(async () => {
  await server.close();
});

describe('gamificationRoutes — every route is gated', () => {
  test.each(ROUTES)('GET $path 401s with no Authorization header and never reaches its controller', async ({ path }) => {
    const res = await http.get(`/api/gamification${path}`);
    expect(res.status).toBe(401);
    expect(log.hits).toEqual([]);
  });

  test.each(ROUTES)('GET $path 403s EMAIL_NOT_VERIFIED for an unverified credentials user, not 401', async ({ path }) => {
    const user = await makeUser({ emailVerified: false });
    const res = await http.get(`/api/gamification${path}`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
    expect(res.json?.errorCode).toBe('EMAIL_NOT_VERIFIED');
    expect(log.hits).toEqual([]);
  });

  test.each(ROUTES)('GET $path reaches $controller for a verified user (harness sanity)', async ({ path, controller }) => {
    const user = await makeUser({ emailVerified: true });
    const res = await http.get(`/api/gamification${path}`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual([controller]);
  });
});

describe('gamificationRoutes — registration shape', () => {
  const stack = (gamificationRoutes as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean> }; handle: unknown }[];
  }).stack;

  test('the gate layers sit before every route, in order protect → requireVerified → usageContext', () => {
    const firstRouteIdx = stack.findIndex((l) => l.route);
    const idx = (fn: unknown) => stack.findIndex((l) => !l.route && l.handle === fn);
    expect(idx(protect)).toBeGreaterThanOrEqual(0);
    expect(idx(protect)).toBeLessThan(idx(requireVerified));
    expect(idx(requireVerified)).toBeLessThan(idx(usageContextMiddleware));
    expect(idx(usageContextMiddleware)).toBeLessThan(firstRouteIdx);
  });

  test('the route table covers every route the router registers', () => {
    const registered = stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path}`))
      .sort();
    expect(registered).toEqual(ROUTES.map((r) => `get ${r.path}`).sort());
  });
});
