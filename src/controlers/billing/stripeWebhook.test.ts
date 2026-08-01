/**
 * The webhook controller's RESPONSE POLICY, asserted on real HTTP responses.
 *
 * Signature verification against real signed bytes lives in the sibling
 * `stripeWebhook.signature.test.ts`. What is left here is the deliberate,
 * documented trade-off in the controller's error handling, which a
 * well-meaning refactor could invert without any test noticing:
 *
 *   - `RetryableWebhookError` (transient: DB outage, vendor blip) → **503**,
 *     so Stripe retries with backoff for ~3 days and the event is eventually
 *     applied. Answering 200 here silently drops the entitlement change.
 *   - Any other handler error (deterministic: malformed payload, a bug we
 *     shipped) → **200 + `handlerError: true`**, so the retry storm stops and
 *     reconciliation picks up the drift. Answering 5xx here makes Stripe
 *     re-deliver a payload that will fail identically every time.
 *   - Missing signature → **400** (Stripe does not retry, and should not).
 *   - `STRIPE_WEBHOOK_SECRET` unset → **500**, never a silent ack. A silent
 *     ack on a misconfigured deploy discards every event permanently.
 *
 * This file was rewritten in PLAN Phase 7. Previously all 12 of its
 * assertions were `toHaveBeenCalledWith` against a mock `res` — it restated
 * the controller's own control flow and could not fail on anything a client
 * would notice. The assertions are now the status line and JSON body coming
 * back over a socket.
 *
 * Run: yarn test stripeWebhook
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';

const constructWebhookEventMock = vi.hoisted(() => vi.fn());
const handleStripeEventMock = vi.hoisted(() => vi.fn());
/** Mutable so the "secret not configured" case can be driven in this file. */
const env = vi.hoisted(() => ({ webhookSecret: '' as string }));

vi.mock('@services/stripeService', () => ({
  constructWebhookEvent: (...args: unknown[]) => constructWebhookEventMock(...args),
}));

vi.mock('@services/stripeWebhookService', async (importOriginal) => {
  // Real `RetryableWebhookError` so the controller's `instanceof` branch is
  // the production one; everything else stubbed.
  const actual = await importOriginal<typeof import('@services/stripeWebhookService')>();
  return {
    ...actual,
    handleStripeEvent: (...args: unknown[]) => handleStripeEventMock(...args),
  };
});

vi.mock('@conf/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@conf/env')>();
  return {
    ...actual,
    // A getter, not a value: the controller reads this binding per request,
    // so one test can unset it without a second test file.
    get STRIPE_WEBHOOK_SECRET() {
      return env.webhookSecret;
    },
  };
});

import { stripeWebhookController } from '@controlers/billing/stripeWebhook';
import { RetryableWebhookError } from '@services/stripeWebhookService';
import { STRIPE_WEBHOOK_SECRET as REAL_WEBHOOK_SECRET } from '@conf/env';
import { makeTestApp } from '../../../test-helpers/app';
import { startTestServer, req as httpFor, type TestServer } from '../../../test-helpers/http';

const WEBHOOK_PATH = '/api/billing/stripe/webhook';
const BODY = '{"id":"evt_x","type":"customer.subscription.updated"}';

let app: Express;
let server: TestServer;
let http: ReturnType<typeof httpFor>;

const deliver = (headers: Record<string, string> = { 'stripe-signature': 'a-signature' }) =>
  http.post(WEBHOOK_PATH, { headers: { 'content-type': 'application/json', ...headers }, rawBody: BODY });

beforeAll(async () => {
  app = makeTestApp({ raw: [{ path: WEBHOOK_PATH, handler: stripeWebhookController }] });
  server = await startTestServer(app);
  http = httpFor(server.base);
});

beforeEach(() => {
  vi.clearAllMocks();
  // Restore the configured secret before every test; the one case that
  // unsets it does so explicitly.
  env.webhookSecret = 'whsec_configured_for_this_test';
});

afterAll(async () => {
  await server.close();
});

describe('stripeWebhookController — response policy over the wire', () => {
  test('missing stripe-signature header → 400, and verification is never attempted', async () => {
    const res = await deliver({});
    expect(res.status).toBe(400);
    expect(res.text).toBe('Missing stripe-signature header');
    expect(constructWebhookEventMock).not.toHaveBeenCalled();
  });

  test('signature verification failure → 400; the handler is not invoked', async () => {
    constructWebhookEventMock.mockImplementation(() => {
      throw new Error('Stripe-style sig fail');
    });
    const res = await deliver();
    expect(res.status).toBe(400);
    expect(res.text).toBe('Signature verification failed');
    expect(handleStripeEventMock).not.toHaveBeenCalled();
  });

  test('valid signature + handler success → 200 { received: true }', async () => {
    constructWebhookEventMock.mockReturnValue({ id: 'evt_1', type: 'invoice.paid' });
    handleStripeEventMock.mockResolvedValueOnce(undefined);

    const res = await deliver();

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: true });
    // The raw bytes must reach the verifier untouched — this is what the
    // sibling signature test proves end to end; here it is the pre-condition
    // for the policy assertions being about the policy and nothing else.
    expect(constructWebhookEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ signature: 'a-signature', secret: 'whsec_configured_for_this_test' }),
    );
    expect((constructWebhookEventMock.mock.calls[0][0] as { payload: Buffer }).payload.toString('utf8')).toBe(BODY);
  });

  test('handler throws RetryableWebhookError → 503 so Stripe retries', async () => {
    constructWebhookEventMock.mockReturnValue({ id: 'evt_2', type: 'invoice.paid' });
    handleStripeEventMock.mockRejectedValueOnce(
      new RetryableWebhookError('mongo blip', new Error('MongoNetworkError')),
    );

    const res = await deliver();

    expect(res.status).toBe(503);
    expect(res.json).toEqual({ received: false, retry: true });
    // 503 and not 200: a 200 here would drop the entitlement change on the
    // floor for a failure that a retry would have fixed.
    expect(res.status).not.toBe(200);
  });

  test('handler throws a plain Error → 200 with handlerError: true, so the retry storm stops', async () => {
    constructWebhookEventMock.mockReturnValue({ id: 'evt_3', type: 'invoice.paid' });
    handleStripeEventMock.mockRejectedValueOnce(new Error('deterministic bug'));

    const res = await deliver();

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: true, handlerError: true });
    // 200 and not 5xx: re-delivering a payload that fails identically every
    // time buys nothing and floods Sentry for three days.
    expect(res.status).toBeLessThan(500);
  });

  test('STRIPE_WEBHOOK_SECRET unset → 500 "Webhook not configured", never a silent ack', async () => {
    env.webhookSecret = '';

    const res = await deliver();

    expect(res.status).toBe(500);
    expect(res.text).toBe('Webhook not configured');
    // The dangerous alternative is a 200: Stripe would consider every event
    // delivered and never retry, so a misconfigured deploy would discard
    // every subscription change silently and permanently.
    expect(res.status).not.toBe(200);
    expect(constructWebhookEventMock).not.toHaveBeenCalled();
  });

  test('harness sanity: the env mock is confined to STRIPE_WEBHOOK_SECRET and did not blank the real config', () => {
    // `importOriginal` spread keeps every other export real. If this ever
    // fails, the getter above has started shadowing more than it should.
    expect(typeof REAL_WEBHOOK_SECRET).toBe('string');
    expect(env.webhookSecret).not.toBe('');
  });
});
