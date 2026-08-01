/**
 * The admin gate, driven over REAL HTTP against the REAL `adminRoutes`.
 *
 * The production bug this file exists to prevent: `requireAdmin` (or
 * `requireVerified`, or `protect`) dropped from, or reordered inside,
 * `adminRoutes.ts`'s single `router.use(protect, requireVerified, requireAdmin)`
 * line — after which any signed-in user can `POST /api/admin/marketing/send`
 * and mass-mail the entire contact ledger. That send is irreversible and
 * carries consent/GDPR consequences; there is no undo and no rate limiter
 * behind it. `sendMarketingCampaign.test.ts` is thorough but calls the
 * controller as a bare function, i.e. from *past* the gate — so it cannot
 * see the gate disappear.
 *
 * Second bug class, equally silent: the refusal returned as **401** instead
 * of 403. A 401 trips the client's axios auto-sign-out interceptor, so a
 * verified non-admin who touches an admin URL gets evicted from their
 * session. Every 403 case below therefore also asserts `not 401`.
 *
 * Method
 *   - NEGATIVE cases mock nothing that matters: the gate rejects before any
 *     controller runs, so no mail can be sent and the assertion is a real
 *     HTTP status off a real socket.
 *   - POSITIVE cases replace `@controlers/admin` with 204 sentinels, because
 *     the behaviour under test is "the gate let the request through", not
 *     "the campaign sends". Without this a green test would send mail.
 *   - The route list is a table. A fifth route added below the gate is a
 *     one-line addition here; a route added ABOVE the gate, or one added and
 *     not listed here at all, fails `covers every route registered on the
 *     router` below.
 *
 * Run: yarn test adminRoutes
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';

// Sentinel controllers. `vi.hoisted` runs above the `vi.mock` factory, which
// itself must be above `import { adminRoutes }` — the router captures the
// controller references at module load, so a mock registered afterwards
// would be ignored and the real mass-mail controller would run.
const sentinel = vi.hoisted(() => ({ hits: [] as string[] }));

vi.mock('@controlers/admin', () => {
  const make =
    (name: string) =>
    (_req: unknown, res: { status: (n: number) => { end: () => void } }) => {
      sentinel.hits.push(name);
      res.status(204).end();
    };
  return {
    sendPromotionalTestEmailController: make('sendPromotionalTestEmail'),
    sendMarketingCampaignController: make('sendMarketingCampaign'),
    listMarketingCampaignClaimsController: make('listMarketingCampaignClaims'),
    reclaimMarketingCampaignClaimsController: make('reclaimMarketingCampaignClaims'),
  };
});

import { adminRoutes } from '@routes/adminRoutes';
import { protect, requireAdmin, requireVerified } from '@middleware/authMiddleware';
import { AuthProvider } from '@lib/constants';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, UserModel } from '../../test-helpers/factories';
import { makeTestApp } from '../../test-helpers/app';
import { startTestServer, authHeaderFor, req as httpFor, type TestServer } from '../../test-helpers/http';

setupTestDb();

/** Every route below the gate, with the sentinel it must reach when allowed. */
const GATED_ROUTES = [
  { method: 'post', path: '/email/send-promotional-test', controller: 'sendPromotionalTestEmail' },
  { method: 'post', path: '/marketing/send', controller: 'sendMarketingCampaign' },
  { method: 'get', path: '/marketing/claims', controller: 'listMarketingCampaignClaims' },
  { method: 'post', path: '/marketing/reclaim', controller: 'reclaimMarketingCampaignClaims' },
] as const;

let app: Express;
let server: TestServer;
let http: ReturnType<typeof httpFor>;

const send = (route: (typeof GATED_ROUTES)[number], headers?: Record<string, string>) =>
  route.method === 'get'
    ? http.get(`/api/admin${route.path}`, { headers })
    : http.post(`/api/admin${route.path}`, { headers, body: {} });

beforeAll(async () => {
  app = makeTestApp({ mount: { '/api/admin': adminRoutes } });
  server = await startTestServer(app);
  http = httpFor(server.base);
});

beforeEach(() => {
  sentinel.hits.length = 0;
});

afterAll(async () => {
  await server.close();
});

describe('adminRoutes — the gate chain, over the wire', () => {
  test.each(GATED_ROUTES)(
    '$method $path — NO Authorization header is refused with 401 and never reaches the controller',
    async (route) => {
      const res = await send(route);
      expect(res.status).toBe(401);
      expect(sentinel.hits).toEqual([]);
    },
  );

  test.each(GATED_ROUTES)(
    '$method $path — a verified NON-ADMIN is refused with 403, is NOT signed out (401), and never reaches the controller',
    async (route) => {
      const user = await makeUser({ emailVerified: true, isAdmin: false });
      // Precondition made explicit: `requireVerified` only gates accounts
      // holding a CREDENTIALS provider, so a future factory-default change
      // must not silently turn this into a test of the wrong gate.
      expect(user.authProviders.map((p) => p.provider)).toContain(AuthProvider.CREDENTIALS);

      const res = await send(route, authHeaderFor(user));

      expect(res.status).toBe(403);
      expect(res.status).not.toBe(401);
      expect(res.json?.message).toMatch(/admin access required/i);
      expect(sentinel.hits).toEqual([]);
    },
  );

  test.each(GATED_ROUTES)(
    '$method $path — an UNVERIFIED credentials user is refused with 403 EMAIL_NOT_VERIFIED, before requireAdmin runs',
    async (route) => {
      const user = await makeUser({ emailVerified: false, isAdmin: true });
      const res = await send(route, authHeaderFor(user));

      expect(res.status).toBe(403);
      expect(res.status).not.toBe(401);
      // The user IS an admin — so an EMAIL_NOT_VERIFIED code here is what
      // proves `requireVerified` ran BEFORE `requireAdmin`. If the order were
      // flipped, this admin would sail through to the controller.
      expect(res.json?.errorCode).toBe('EMAIL_NOT_VERIFIED');
      expect(sentinel.hits).toEqual([]);
    },
  );

  test.each(GATED_ROUTES)('$method $path — a verified ADMIN passes the gate', async (route) => {
    const user = await makeUser({ emailVerified: true, isAdmin: true });
    const res = await send(route, authHeaderFor(user));

    expect(res.status).toBe(204);
    expect(sentinel.hits).toEqual([route.controller]);
  });

  test.each(GATED_ROUTES)(
    '$method $path — an admin whose tokenVersion was bumped (post-logout) is refused with 401',
    async (route) => {
      const user = await makeUser({ emailVerified: true, isAdmin: true, tokenVersion: 0 });
      const header = authHeaderFor(user); // minted at v0
      await UserModel.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });

      const res = await send(route, header);
      // 401 IS correct here — the session is genuinely revoked, so signing
      // the caller out is the desired client behaviour.
      expect(res.status).toBe(401);
      expect(sentinel.hits).toEqual([]);
    },
  );

  test('a garbage bearer token is refused with 401, not 500', async () => {
    const res = await send(GATED_ROUTES[1], { Authorization: 'Bearer not-a-jwt' });
    expect(res.status).toBe(401);
    expect(sentinel.hits).toEqual([]);
  });

  test('harness sanity: an unknown path under the same mount 404s, so a blanket-403 harness cannot fake the results above', async () => {
    const admin = await makeUser({ emailVerified: true, isAdmin: true });
    const res = await http.get('/api/admin/marketing/does-not-exist', { headers: authHeaderFor(admin) });
    expect(res.status).toBe(404);
  });
});

describe('adminRoutes — registration shape', () => {
  const stack = (adminRoutes as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> }; handle: unknown }[] }).stack;

  test('the gate layers are registered BEFORE every route layer', () => {
    const firstRouteIdx = stack.findIndex((l) => l.route);
    const gateHandles = [protect, requireVerified, requireAdmin];
    for (const gate of gateHandles) {
      const idx = stack.findIndex((l) => !l.route && l.handle === gate);
      expect(idx, `${(gate as { name?: string }).name ?? 'gate'} is not mounted on adminRoutes at all`).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(firstRouteIdx);
    }
  });

  test('the gate order is protect → requireVerified → requireAdmin', () => {
    const idx = (fn: unknown) => stack.findIndex((l) => !l.route && l.handle === fn);
    expect(idx(protect)).toBeLessThan(idx(requireVerified));
    expect(idx(requireVerified)).toBeLessThan(idx(requireAdmin));
  });

  test('GATED_ROUTES covers every route registered on the router — a new admin route without a gate test fails here', () => {
    const registered = stack
      .filter((l) => l.route)
      .flatMap((l) =>
        Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path}`),
      )
      .sort();
    const covered = GATED_ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(registered).toEqual(covered);
  });
});
