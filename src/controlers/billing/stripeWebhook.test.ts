/**
 * Tests for the webhook *controller* (not the service). The big
 * `stripeWebhookService.test.ts` covers per-handler logic by calling
 * `handleStripeEvent` directly — bypassing signature verification entirely.
 * This file gates the controller-layer responsibilities:
 *   - signature verification rejects bad / missing signatures
 *   - misconfigured webhook secret returns 500 (not silent ack)
 *   - retryable handler errors → 5xx so Stripe retries
 *   - deterministic handler errors → 200 + handlerError flag (audit
 *     deliberately ack-and-log here; reconciliation cron handles drift)
 *
 * Run: yarn test stripeWebhook
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// Mock the deps the controller uses BEFORE importing it.
const constructWebhookEventMock = vi.fn();
const handleStripeEventMock = vi.fn();

vi.mock('@services/stripeService', () => ({
  constructWebhookEvent: (...args: unknown[]) => constructWebhookEventMock(...args),
}));

vi.mock('@services/stripeWebhookService', async () => {
  // Real RetryableWebhookError class so `instanceof` checks work in the
  // controller. Everything else is a stub.
  const actual = await vi.importActual<typeof import('@services/stripeWebhookService')>(
    '@services/stripeWebhookService',
  );
  return {
    handleStripeEvent: (...args: unknown[]) => handleStripeEventMock(...args),
    RetryableWebhookError: actual.RetryableWebhookError,
  };
});

import { stripeWebhookController } from '@controlers/billing/stripeWebhook';
import { RetryableWebhookError } from '@services/stripeWebhookService';

const buildReqRes = ({
  signature,
  body = Buffer.from('{"id":"evt_x","type":"customer.subscription.updated"}'),
}: {
  signature?: string;
  body?: Buffer;
} = {}) => {
  const status = vi.fn();
  const json = vi.fn();
  const send = vi.fn();
  const res = {
    statusCode: 200,
    status: status.mockImplementation(function (this: Response, code: number) {
      (this as unknown as { statusCode: number }).statusCode = code;
      return this;
    }),
    json,
    send,
  } as unknown as Response;
  const req = {
    headers: signature !== undefined ? { 'stripe-signature': signature } : {},
    body,
  } as unknown as Request;
  return { req, res, status, json, send };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stripeWebhookController', () => {
  test('missing stripe-signature header → 400', async () => {
    const { req, res, send } = buildReqRes({ signature: undefined });
    await stripeWebhookController(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith('Missing stripe-signature header');
    expect(constructWebhookEventMock).not.toHaveBeenCalled();
  });

  test('invalid signature → 400; handler is not invoked', async () => {
    constructWebhookEventMock.mockImplementation(() => {
      throw new Error('Stripe-style sig fail');
    });
    const { req, res, send } = buildReqRes({ signature: 't=123,v1=garbage' });
    await stripeWebhookController(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith('Signature verification failed');
    expect(handleStripeEventMock).not.toHaveBeenCalled();
  });

  test('valid signature + handler success → 200 { received: true }', async () => {
    constructWebhookEventMock.mockReturnValue({ id: 'evt_1', type: 'invoice.paid' });
    handleStripeEventMock.mockResolvedValueOnce(undefined);
    const { req, res, json } = buildReqRes({ signature: 'real-signature' });
    await stripeWebhookController(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ received: true });
  });

  test('handler throws RetryableWebhookError → 503 (Stripe retries)', async () => {
    constructWebhookEventMock.mockReturnValue({ id: 'evt_2', type: 'invoice.paid' });
    handleStripeEventMock.mockRejectedValueOnce(
      new RetryableWebhookError('mongo blip', new Error('MongoNetworkError')),
    );
    const { req, res, json } = buildReqRes({ signature: 'real-signature' });
    await stripeWebhookController(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({ received: false, retry: true });
  });

  test('handler throws plain Error → 200 with handlerError flag (no retry)', async () => {
    constructWebhookEventMock.mockReturnValue({ id: 'evt_3', type: 'invoice.paid' });
    handleStripeEventMock.mockRejectedValueOnce(new Error('determinstic bug'));
    const { req, res, json } = buildReqRes({ signature: 'real-signature' });
    await stripeWebhookController(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ received: true, handlerError: true });
  });
});
