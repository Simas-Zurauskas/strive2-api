/**
 * Stripe webhook signature verification against REAL SIGNED BYTES.
 *
 * The realistic production bug here is not "the handler mishandles an event".
 * It is: **a body-parser reorder, or an SDK bump, makes every real delivery
 * 400.** Entitlements freeze — no subscription activations, no top-ups, no
 * cancellations — and nothing alerts, because from the API's point of view
 * it is answering 400s correctly all day. It surfaces when a customer
 * complains that they paid and got nothing.
 *
 * `stripeWebhook.test.ts` cannot catch that: it stubs `constructWebhookEvent`,
 * so it never signs or verifies anything. This file does the opposite —
 * `@services/stripeService` is NOT mocked, the payload is signed with the
 * SDK's own `webhooks.generateTestHeaderString` using the configured
 * `STRIPE_WEBHOOK_SECRET`, and the request is delivered over a real socket.
 * `handleStripeEvent` is the only thing stubbed, because the subject under
 * test is verification and byte fidelity, not what the handler then does.
 *
 * Case (2) is the whole point of the file: the SAME valid request is replayed
 * against an app where `express.json()` is mounted BEFORE the raw route.
 * That is the production failure, constructed deliberately —
 * `express.json()` consumes and re-serialises the body, and a signature
 * computed over the original bytes cannot verify against re-serialised ones.
 *
 * NB on SDK drift: `webhooks.generateTestHeaderString` is a Stripe SDK test
 * utility (present in `stripe@22`). If a future major removes it, the
 * replacement is to compute the header by hand:
 *   `t=<unix>,v1=HMAC-SHA256(`${t}.${payload}`, secret)`.
 * Written down here so the fix is obvious rather than archaeological.
 *
 * Run: yarn test stripeWebhook.signature
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';

const handler = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('@services/stripeWebhookService', async (importOriginal) => {
  // The real `RetryableWebhookError` class is kept so the controller's
  // `instanceof` branch behaves as it does in production.
  const actual = await importOriginal<typeof import('@services/stripeWebhookService')>();
  return {
    ...actual,
    handleStripeEvent: (event: { id: string; type: string }) => {
      handler.calls.push(`${event.type}:${event.id}`);
      return Promise.resolve();
    },
  };
});

import { stripeWebhookController } from '@controlers/billing/stripeWebhook';
import { getStripe } from '@services/stripeService';
import { STRIPE_WEBHOOK_SECRET } from '@conf/env';
import { makeTestApp } from '../../../test-helpers/app';
import { startTestServer, req as httpFor, type TestServer } from '../../../test-helpers/http';

const WEBHOOK_PATH = '/api/billing/stripe/webhook';

/** A minimally well-formed Stripe event body. */
const PAYLOAD = JSON.stringify({
  id: 'evt_signature_test',
  object: 'event',
  api_version: '2024-06-20',
  created: 1_700_000_000,
  type: 'invoice.paid',
  data: { object: { id: 'in_test', object: 'invoice' } },
});

const sign = (opts: { payload?: string; secret?: string; timestamp?: number } = {}) =>
  getStripe().webhooks.generateTestHeaderString({
    payload: opts.payload ?? PAYLOAD,
    secret: opts.secret ?? STRIPE_WEBHOOK_SECRET,
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
  });

let correctApp: Express;
let correctServer: TestServer;
let correct: ReturnType<typeof httpFor>;

let brokenApp: Express;
let brokenServer: TestServer;
let broken: ReturnType<typeof httpFor>;

beforeAll(async () => {
  // Production ordering: express.raw() for this route BEFORE express.json().
  correctApp = makeTestApp({ raw: [{ path: WEBHOOK_PATH, handler: stripeWebhookController }] });
  correctServer = await startTestServer(correctApp);
  correct = httpFor(correctServer.base);

  // The bug, made constructible: express.json() first.
  brokenApp = makeTestApp({
    raw: [{ path: WEBHOOK_PATH, handler: stripeWebhookController }],
    rawAfterJson: true,
  });
  brokenServer = await startTestServer(brokenApp);
  broken = httpFor(brokenServer.base);
});

beforeEach(() => {
  handler.calls.length = 0;
});

afterAll(async () => {
  await correctServer.close();
  await brokenServer.close();
});

describe('stripe webhook signature — correctly mounted (express.raw before express.json)', () => {
  test('a genuinely signed delivery verifies and is acked with 200', async () => {
    const res = await correct.post(WEBHOOK_PATH, {
      headers: { 'stripe-signature': sign(), 'content-type': 'application/json' },
      rawBody: PAYLOAD,
    });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: true });
    // Proves verification really happened rather than being skipped: the
    // handler received the parsed event, with the id from the signed bytes.
    expect(handler.calls).toEqual(['invoice.paid:evt_signature_test']);
  });

  test('the exact same signature over a TAMPERED payload is rejected with 400', async () => {
    const signature = sign();
    const tampered = PAYLOAD.replace('in_test', 'in_attacker');
    expect(tampered).not.toBe(PAYLOAD);

    const res = await correct.post(WEBHOOK_PATH, {
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      rawBody: tampered,
    });

    expect(res.status).toBe(400);
    expect(res.text).toBe('Signature verification failed');
    expect(handler.calls).toEqual([]);
  });

  test('a signature minted with the WRONG secret is rejected with 400', async () => {
    const res = await correct.post(WEBHOOK_PATH, {
      headers: {
        'stripe-signature': sign({ secret: 'whsec_someone_elses_endpoint' }),
        'content-type': 'application/json',
      },
      rawBody: PAYLOAD,
    });

    expect(res.status).toBe(400);
    expect(res.text).toBe('Signature verification failed');
    expect(handler.calls).toEqual([]);
  });

  test('a missing stripe-signature header is rejected with 400 before any verification', async () => {
    const res = await correct.post(WEBHOOK_PATH, {
      headers: { 'content-type': 'application/json' },
      rawBody: PAYLOAD,
    });

    expect(res.status).toBe(400);
    expect(res.text).toBe('Missing stripe-signature header');
    expect(handler.calls).toEqual([]);
  });

  test('a signature whose timestamp is outside Stripe\'s 300s tolerance is rejected with 400 (replay defence)', async () => {
    // A LITERAL past timestamp, not a faked clock: `vi.setSystemTime` would
    // move our clock and the SDK's together, and the test would pass for the
    // wrong reason (or not at all).
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const res = await correct.post(WEBHOOK_PATH, {
      headers: {
        'stripe-signature': sign({ timestamp: oneHourAgo }),
        'content-type': 'application/json',
      },
      rawBody: PAYLOAD,
    });

    expect(res.status).toBe(400);
    expect(handler.calls).toEqual([]);
  });

  test('a garbage stripe-signature header is rejected with 400, not a 500', async () => {
    const res = await correct.post(WEBHOOK_PATH, {
      headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
      rawBody: PAYLOAD,
    });

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(handler.calls).toEqual([]);
  });
});

describe('stripe webhook signature — THE production failure: express.json() mounted first', () => {
  test('a VALID delivery 400s when the JSON parser runs before the raw route — every real event would freeze entitlements', async () => {
    const signature = sign();

    // Identical request, byte for byte, to the passing case above.
    const good = await correct.post(WEBHOOK_PATH, {
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      rawBody: PAYLOAD,
    });
    expect(good.status).toBe(200);

    handler.calls.length = 0;

    const bad = await broken.post(WEBHOOK_PATH, {
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      rawBody: PAYLOAD,
    });

    expect(bad.status).toBe(400);
    expect(bad.text).toBe('Signature verification failed');
    expect(handler.calls).toEqual([]);
  });

  test('the two apps disagree on the same request — harness sanity for the case above', async () => {
    const signature = sign();
    const init = {
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      rawBody: PAYLOAD,
    };
    const a = await correct.post(WEBHOOK_PATH, init);
    const b = await broken.post(WEBHOOK_PATH, init);
    expect(a.status).not.toBe(b.status);
    expect([a.status, b.status]).toEqual([200, 400]);
  });
});
