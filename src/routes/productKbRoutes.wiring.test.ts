/**
 * `productKbRoutes` wiring, over REAL HTTP against the REAL router.
 *
 * This is the INVERSE assertion to every other file in this phase: the
 * product-KB chat is deliberately PUBLIC — `optionalProtect`, no `protect`,
 * no `requireVerified`, no `requireCredits`. The production bug this file
 * exists to prevent is someone "hardening" it by adding one of those gates.
 * It is the help bot on the marketing site and in the signed-out app shell;
 * a 401 or 402 there is invisible in every authenticated test environment and
 * silently kills pre-signup support for anonymous visitors.
 *
 * The second, quieter bug: `optionalProtect` replaced by something that
 * rejects. Its contract is "never reject, never 5xx, attach `req.userId` only
 * when the bearer is fully valid" — so a garbage or revoked token must fall
 * through to anonymous mode rather than erroring. Attribution still has to
 * work when the token IS valid, because the usage telemetry behind this
 * endpoint is how the free bot's cost is attributed to real accounts.
 *
 * Method: the controller is a sentinel that records the `req.userId` the
 * middleware chain produced, so "answered anonymously" and "attributed to
 * user X" are distinguishable. Request volume is kept well under the 8/min
 * burst limiter — the limiter itself is Phase 10's subject, not this file's.
 *
 * Run: yarn test productKbRoutes.wiring
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express, Request, Response } from 'express';

const log = vi.hoisted(() => ({ hits: [] as string[] }));

vi.mock('@controlers/productKb', () => ({
  productKbChatController: (req: Request, res: Response) => {
    // Record the attribution the chain produced, not just that we arrived.
    log.hits.push(`chat:${req.userId ?? 'anonymous'}`);
    res.status(204).end();
  },
}));

import { productKbRoutes } from '@routes/productKbRoutes';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, UserModel } from '../../test-helpers/factories';
import { makeTestApp } from '../../test-helpers/app';
import { startTestServer, authHeaderFor, req as httpFor, type TestServer } from '../../test-helpers/http';

setupTestDb();

let app: Express;
let server: TestServer;
let http: ReturnType<typeof httpFor>;

beforeAll(async () => {
  app = makeTestApp({ mount: { '/api/product-kb': productKbRoutes } });
  server = await startTestServer(app);
  http = httpFor(server.base);
});

beforeEach(() => {
  log.hits.length = 0;
});

afterAll(async () => {
  await server.close();
});

describe('productKbRoutes — POST /chat is public', () => {
  test('answers an anonymous caller: not 401, not 402, and the controller sees no userId', async () => {
    const res = await http.post('/api/product-kb/chat', { body: { message: 'hi' } });
    expect(res.status).toBe(204);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(402);
    expect(log.hits).toEqual(['chat:anonymous']);
  });

  test('a garbage bearer token falls through to anonymous — optionalProtect never rejects', async () => {
    const res = await http.post('/api/product-kb/chat', {
      headers: { Authorization: 'Bearer not-a-jwt' },
      body: { message: 'hi' },
    });
    expect(res.status).toBe(204);
    expect(res.status).not.toBe(401);
    expect(log.hits).toEqual(['chat:anonymous']);
  });

  test('a valid bearer IS attributed — the controller sees req.userId', async () => {
    const user = await makeUser({ emailVerified: true });
    const res = await http.post('/api/product-kb/chat', {
      headers: authHeaderFor(user),
      body: { message: 'hi' },
    });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual([`chat:${user._id.toString()}`]);
  });

  test('an UNVERIFIED user is still served and still attributed — there is no requireVerified here', async () => {
    const user = await makeUser({ emailVerified: false });
    const res = await http.post('/api/product-kb/chat', {
      headers: authHeaderFor(user),
      body: { message: 'hi' },
    });
    expect(res.status).toBe(204);
    expect(res.status).not.toBe(403);
    expect(log.hits).toEqual([`chat:${user._id.toString()}`]);
  });

  test('a user at ZERO balance is still served — the bot is free, there is no requireCredits here', async () => {
    const now = new Date();
    const user = await makeUser({
      emailVerified: true,
      credits: {
        allowanceBalance: 0,
        allowanceGranted: 0,
        bonusBalance: 0,
        periodStart: now,
        periodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const res = await http.post('/api/product-kb/chat', {
      headers: authHeaderFor(user),
      body: { message: 'hi' },
    });
    expect(res.status).toBe(204);
    expect(res.status).not.toBe(402);
    expect(log.hits).toEqual([`chat:${user._id.toString()}`]);
  });

  test('a revoked (stale tokenVersion) session degrades to anonymous rather than 401', async () => {
    const user = await makeUser({ emailVerified: true, tokenVersion: 0 });
    const header = authHeaderFor(user);
    await UserModel.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    const res = await http.post('/api/product-kb/chat', { headers: header, body: { message: 'hi' } });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['chat:anonymous']);
  });
});

describe('productKbRoutes — registration shape', () => {
  const stack = (productKbRoutes as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean> }; handle: unknown }[];
  }).stack;

  test('the router mounts no router-wide gate at all', () => {
    expect(stack.filter((l) => !l.route)).toEqual([]);
  });

  test('POST /chat is the only route — a second one here would need its own public/gated decision', () => {
    const registered = stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path}`));
    expect(registered).toEqual(['post /chat']);
  });
});
