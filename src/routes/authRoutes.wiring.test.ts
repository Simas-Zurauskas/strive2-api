/**
 * `authRoutes` gate wiring, over REAL HTTP against the REAL router.
 *
 * The production bug this file exists to prevent runs in BOTH directions,
 * and both are silent:
 *
 *   1. **A gate added where it must not be.** `/me`, `/logout`,
 *      `/resend-verification-authenticated` and `/delete-account` must stay
 *      reachable for an UNVERIFIED user. Put `requireVerified` on this router
 *      and every unverified user is stranded: they cannot fetch their own
 *      profile, cannot resend the verification mail, and cannot delete the
 *      account — a support ticket per signup, and a GDPR problem for the
 *      delete path.
 *   2. **A gate omitted where it must be.** This router gates PER ROUTE —
 *      there is no `router.use(protect)` — so a new route is PUBLIC unless
 *      someone remembers to type `protect` into its argument list. Forgetting
 *      it on, say, `/me/preferences` exposes another user's settings to an
 *      anonymous caller with a guessed id.
 *
 * Method: `@controlers/auth` is replaced with 204 sentinels. Negative cases
 * never reach a controller anyway; the positive cases must NOT run the real
 * ones, which send mail (Mailjet), call Google's OAuth endpoint and delete
 * S3/Pinecone data. The assertion is the real HTTP status plus whether the
 * sentinel was reached.
 *
 * The route tables below are asserted to cover every route the router
 * registers, so a new route forces a decision here instead of quietly
 * inheriting whichever default it landed on.
 *
 * Run: yarn test authRoutes.wiring
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
// Imported statically (not via `await import()` inside the factory): a
// dynamic relative import needs an explicit extension under NodeNext and
// `yarn tsc` rejects it. This module is evaluated before the router import
// below, so the lazy `vi.mock` factory sees it initialised.
import { sentinelControllers } from '../../test-helpers/routeSentinels';

const log = vi.hoisted(() => ({ hits: [] as string[] }));

vi.mock('@controlers/auth', () => sentinelControllers(log, [
  'signInController',
  'signUpController',
  'googleAuthController',
  'getMeController',
  'verifyEmailController',
  'resendVerificationController',
  'resendVerificationAuthenticatedController',
  'deleteAccountController',
  'logoutController',
  'forgotPasswordController',
  'resetPasswordController',
  'setPasswordController',
  'changePasswordController',
  'updatePreferencesController',
  'requestSecurityActionCodeController',
  'refreshTokenController',
  'getMarketingPreferenceController',
  'updateMarketingPreferenceController',
  'recordConsentController',
  'recordAttributionController',
  'unsubscribeMarketingController',
  'unsubscribeMarketingConfirmController',
  ]));

import { authRoutes } from '@routes/authRoutes';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser } from '../../test-helpers/factories';
import { makeTestApp } from '../../test-helpers/app';
import { startTestServer, authHeaderFor, req as httpFor, type TestServer } from '../../test-helpers/http';

setupTestDb();

type Method = 'get' | 'post' | 'patch' | 'delete';
interface RouteSpec {
  method: Method;
  path: string;
  controller: string;
}

/** Registered WITHOUT `protect` — must answer with no Authorization header. */
const PUBLIC_ROUTES: RouteSpec[] = [
  { method: 'post', path: '/marketing/unsubscribe', controller: 'unsubscribeMarketingController' },
  { method: 'get', path: '/marketing/unsubscribe', controller: 'unsubscribeMarketingConfirmController' },
  { method: 'post', path: '/signin', controller: 'signInController' },
  { method: 'post', path: '/signup', controller: 'signUpController' },
  { method: 'post', path: '/google', controller: 'googleAuthController' },
  { method: 'post', path: '/verify-email', controller: 'verifyEmailController' },
  { method: 'post', path: '/resend-verification', controller: 'resendVerificationController' },
  { method: 'post', path: '/forgot-password', controller: 'forgotPasswordController' },
  { method: 'post', path: '/reset-password', controller: 'resetPasswordController' },
  // `optionalProtect`, not `protect` — anonymous landing visitors log their
  // cookie-banner choice here before any account exists.
  { method: 'post', path: '/consent-log', controller: 'recordConsentController' },
];

/** Registered WITH `protect` — must 401 without a valid bearer token. */
const GATED_ROUTES: RouteSpec[] = [
  { method: 'post', path: '/set-password', controller: 'setPasswordController' },
  { method: 'post', path: '/change-password', controller: 'changePasswordController' },
  { method: 'get', path: '/me', controller: 'getMeController' },
  { method: 'patch', path: '/me/preferences', controller: 'updatePreferencesController' },
  { method: 'get', path: '/me/marketing-preference', controller: 'getMarketingPreferenceController' },
  { method: 'patch', path: '/me/marketing-preference', controller: 'updateMarketingPreferenceController' },
  { method: 'post', path: '/me/attribution', controller: 'recordAttributionController' },
  { method: 'post', path: '/logout', controller: 'logoutController' },
  { method: 'post', path: '/refresh', controller: 'refreshTokenController' },
  { method: 'post', path: '/resend-verification-authenticated', controller: 'resendVerificationAuthenticatedController' },
  { method: 'post', path: '/security-action/request-code', controller: 'requestSecurityActionCodeController' },
  { method: 'delete', path: '/delete-account', controller: 'deleteAccountController' },
];

/**
 * The four an unverified user MUST still reach. A 403 here is the stranding
 * bug described in the header — they cannot verify, resend, or leave.
 */
const UNVERIFIED_REACHABLE: RouteSpec[] = [
  { method: 'get', path: '/me', controller: 'getMeController' },
  { method: 'post', path: '/logout', controller: 'logoutController' },
  { method: 'post', path: '/resend-verification-authenticated', controller: 'resendVerificationAuthenticatedController' },
  { method: 'delete', path: '/delete-account', controller: 'deleteAccountController' },
];

let app: Express;
let server: TestServer;
let http: ReturnType<typeof httpFor>;

const send = (route: RouteSpec, headers?: Record<string, string>) => {
  const url = `/api/auth${route.path}`;
  const init = { headers, ...(route.method === 'get' || route.method === 'delete' ? {} : { body: {} }) };
  if (route.method === 'get') return http.get(url, init);
  if (route.method === 'delete') return http.del(url, init);
  if (route.method === 'patch') return http.patch(url, init);
  return http.post(url, init);
};

beforeAll(async () => {
  app = makeTestApp({ mount: { '/api/auth': authRoutes } });
  server = await startTestServer(app);
  http = httpFor(server.base);
});

beforeEach(() => {
  log.hits.length = 0;
});

afterAll(async () => {
  await server.close();
});

describe('authRoutes — public routes answer with no session', () => {
  test.each(PUBLIC_ROUTES)('$method $path is PUBLIC — reaches its controller with no Authorization header', async (route) => {
    const res = await send(route);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(204);
    expect(log.hits).toEqual([route.controller]);
  });

  test('/consent-log still attributes when a valid bearer IS present (optionalProtect, not protect)', async () => {
    const user = await makeUser();
    const res = await http.post('/api/auth/consent-log', { headers: authHeaderFor(user), body: {} });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['recordConsentController']);
  });

  test('/consent-log does NOT reject a garbage bearer token — optionalProtect never rejects', async () => {
    const res = await http.post('/api/auth/consent-log', {
      headers: { Authorization: 'Bearer not-a-jwt' },
      body: {},
    });
    expect(res.status).toBe(204);
    expect(res.status).not.toBe(401);
  });
});

describe('authRoutes — gated routes refuse anonymous callers', () => {
  test.each(GATED_ROUTES)('$method $path 401s with no Authorization header and never reaches its controller', async (route) => {
    const res = await send(route);
    expect(res.status).toBe(401);
    expect(log.hits).toEqual([]);
  });
});

describe('authRoutes — an unverified user is not stranded', () => {
  test.each(UNVERIFIED_REACHABLE)(
    '$method $path stays reachable for an UNVERIFIED credentials user (a 403 here strands them)',
    async (route) => {
      const user = await makeUser({ emailVerified: false });
      const res = await send(route, authHeaderFor(user));
      expect(res.status).toBe(204);
      expect(res.status).not.toBe(403);
      expect(log.hits).toEqual([route.controller]);
    },
  );

  test('the router mounts no requireVerified layer at all — the mechanism behind the four cases above', () => {
    const stack = (authRoutes as unknown as { stack: { route?: unknown; handle: unknown }[] }).stack;
    // Every layer on this router is a route layer; there is no router-wide
    // `router.use(...)` of any kind. If one appears, the four reachability
    // cases above are the ones to re-read before adding it.
    expect(stack.filter((l) => !l.route)).toEqual([]);
  });
});

describe('authRoutes — registration shape', () => {
  const stack = (authRoutes as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean> } }[];
  }).stack;

  test('the route tables cover every route the router registers — a new route forces a public/gated decision here', () => {
    const registered = stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path}`))
      .sort();
    const covered = [...PUBLIC_ROUTES, ...GATED_ROUTES].map((r) => `${r.method} ${r.path}`).sort();
    expect(registered).toEqual(covered);
  });

  test('no route is listed as both public and gated', () => {
    const publicKeys = new Set(PUBLIC_ROUTES.map((r) => `${r.method} ${r.path}`));
    const overlap = GATED_ROUTES.filter((r) => publicKeys.has(`${r.method} ${r.path}`));
    expect(overlap).toEqual([]);
  });
});
