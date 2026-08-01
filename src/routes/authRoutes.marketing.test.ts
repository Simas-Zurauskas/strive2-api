/**
 * Route-level guard for the public unsubscribe endpoints (PLAN F16).
 *
 * `authRoutes` gates PER ROUTE — there is no `router.use(protect)` — so a
 * new route is public unless someone adds `protect` to its argument list.
 * That makes the mistake silent in both directions, which is why this test
 * mounts the real router and drives it over HTTP with no Authorization
 * header at all:
 *
 *   - the unsubscribe routes must answer WITHOUT a session (a 401 here
 *     would also trip the client's auto-sign-out interceptor), and
 *   - `/me` must still 401, proving the harness would notice if the whole
 *     router silently went public.
 *
 * Run: yarn test authRoutes.marketing
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { setupTestDb } from '../../test-helpers/db';

vi.mock('@services/mailjetContactService', () => ({
  syncSuppression: vi.fn(() => Promise.resolve()),
  setPromotionalSubscribed: vi.fn(),
  getPromotionalSubscribed: vi.fn(),
  deletePromotionalContact: vi.fn(),
  resolvePromotionalListId: vi.fn(),
  PROMOTIONAL_LIST_NAME: 'promotional',
}));

import { authRoutes } from '@routes/authRoutes';
import MarketingContactModel from '@models/MarketingContactModel';
import { buildMarketingUnsubToken, MARKETING_UNSUB_PATH } from '@lib/marketingUnsubToken';
import { MARKETING_EVIDENCE } from '@lib/constants';

setupTestDb();

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// `MARKETING_UNSUB_PATH` is the absolute mount path; the router itself is
// mounted at /api/auth, so strip the prefix to build the router-relative URL.
const unsubUrl = (token: string) => `${base}${MARKETING_UNSUB_PATH}?token=${encodeURIComponent(token)}`;

describe('authRoutes — marketing unsubscribe is public', () => {
  test('POST one-click succeeds with no Authorization header and flips the ledger', async () => {
    const contact = await MarketingContactModel.create({
      email: 'route-post@example.com',
      basis: 'soft_opt_in',
      source: 'registration',
      evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
      optedOut: false,
    });

    const res = await fetch(unsubUrl(buildMarketingUnsubToken(contact._id.toString())), {
      method: 'POST',
      // Exactly what an RFC 8058 one-click mail client sends: a form body
      // the API has no parser for. The token lives in the query string, so
      // the handler must not depend on a parsed body.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect((await MarketingContactModel.findById(contact._id).lean())?.optedOut).toBe(true);
  });

  test('GET confirmation redirects with no Authorization header', async () => {
    const contact = await MarketingContactModel.create({
      email: 'route-get@example.com',
      basis: 'soft_opt_in',
      source: 'registration',
      evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
      optedOut: false,
    });

    const res = await fetch(unsubUrl(buildMarketingUnsubToken(contact._id.toString())), {
      method: 'GET',
      redirect: 'manual',
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\/unsubscribed$/);
    expect((await MarketingContactModel.findById(contact._id).lean())?.optedOut).toBe(true);
  });

  test('an unauthenticated gated route on the same router still 401s (harness sanity + gate regression)', async () => {
    const res = await fetch(`${base}/api/auth/me`);
    expect(res.status).toBe(401);
  });
});
