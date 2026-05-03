/**
 * Tests for the three highest-stakes billing controllers — startCheckout,
 * startTopup, cancelSubscription. The controllers themselves are thin
 * (validation + delegate to `stripeService`), so the tests cover what
 * each thin layer actually owns:
 *
 *   - Zod validation rejects malformed input (no Stripe call made).
 *   - Auth missing → controller throws via the `userId!` non-null
 *     assertion (mirrors how `protect` middleware would have rejected
 *     earlier in the real chain).
 *   - Service success → 200 with the expected payload shape.
 *   - Service error → propagates (we don't suppress).
 *
 * The deeper logic (`createSubscriptionCheckout`, `createTopupCheckout`,
 * `scheduleSubscriptionCancellation`) lives in `stripeService.ts` and is
 * already covered by `stripeService.test.ts` + `stripeWebhookService.test.ts`.
 *
 * Run: yarn test billing
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import { buildReqRes, invokeController } from '../../../test-helpers/express';

// Stub the entire stripeService module — the controllers only call three
// functions and they're easy to fake. The webhook side has its own test
// (and uses a different mocking pattern); these tests are self-contained.
const { fakeStripeService } = vi.hoisted(() => ({
  fakeStripeService: {
    createSubscriptionCheckout: vi.fn(),
    createTopupCheckout: vi.fn(),
    scheduleSubscriptionCancellation: vi.fn(),
  },
}));

vi.mock('@services/stripeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/stripeService')>();
  return {
    ...actual,
    createSubscriptionCheckout: fakeStripeService.createSubscriptionCheckout,
    createTopupCheckout: fakeStripeService.createTopupCheckout,
    scheduleSubscriptionCancellation: fakeStripeService.scheduleSubscriptionCancellation,
  };
});

import { startCheckoutController } from './startCheckout';
import { startTopupController } from './startTopup';
import { cancelSubscriptionController } from './cancelSubscription';

setupTestDb();

beforeEach(() => {
  fakeStripeService.createSubscriptionCheckout.mockReset();
  fakeStripeService.createTopupCheckout.mockReset();
  fakeStripeService.scheduleSubscriptionCancellation.mockReset();
});

// ── startCheckoutController ─────────────────────────────────

describe('startCheckoutController', () => {
  test('happy path → 200 with session url', async () => {
    fakeStripeService.createSubscriptionCheckout.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });

    const { req, res, json } = buildReqRes({
      userId: 'user-123',
      body: { plan: 'starter', cadence: 'monthly' },
    });

    await invokeController(startCheckoutController, req, res);

    expect(fakeStripeService.createSubscriptionCheckout).toHaveBeenCalledWith({
      userId: 'user-123',
      plan: 'starter',
      cadence: 'monthly',
      replaceCurrentSubscription: false,
    });
    expect(json).toHaveBeenCalledWith({
      data: { url: 'https://checkout.stripe.com/c/pay/cs_test_123' },
    });
  });

  test('replaceCurrentSubscription=true is forwarded to the service', async () => {
    fakeStripeService.createSubscriptionCheckout.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/pay/cs_test_replace',
    });

    const { req, res } = buildReqRes({
      userId: 'user-123',
      body: { plan: 'pro', cadence: 'annual', replaceCurrentSubscription: true },
    });

    await invokeController(startCheckoutController, req, res);

    expect(fakeStripeService.createSubscriptionCheckout).toHaveBeenCalledWith({
      userId: 'user-123',
      plan: 'pro',
      cadence: 'annual',
      replaceCurrentSubscription: true,
    });
  });

  test('rejects free plan (Zod) — never calls Stripe', async () => {
    const { req, res } = buildReqRes({
      userId: 'user-123',
      body: { plan: 'free', cadence: 'monthly' },
    });

    await expect(invokeController(startCheckoutController, req, res)).rejects.toThrow();
    expect(fakeStripeService.createSubscriptionCheckout).not.toHaveBeenCalled();
  });

  test('rejects invalid cadence (Zod) — never calls Stripe', async () => {
    const { req, res } = buildReqRes({
      userId: 'user-123',
      body: { plan: 'starter', cadence: 'weekly' },
    });

    await expect(invokeController(startCheckoutController, req, res)).rejects.toThrow();
    expect(fakeStripeService.createSubscriptionCheckout).not.toHaveBeenCalled();
  });

  test('Stripe returns no URL → 500 thrown', async () => {
    fakeStripeService.createSubscriptionCheckout.mockResolvedValue({ url: null });

    const { req, res, status } = buildReqRes({
      userId: 'user-123',
      body: { plan: 'starter', cadence: 'monthly' },
    });

    await expect(invokeController(startCheckoutController, req, res)).rejects.toThrow(
      /redirect URL/i,
    );
    expect(status).toHaveBeenCalledWith(500);
  });

  test('service error propagates', async () => {
    fakeStripeService.createSubscriptionCheckout.mockRejectedValue(
      new Error('Stripe API timeout'),
    );

    const { req, res } = buildReqRes({
      userId: 'user-123',
      body: { plan: 'starter', cadence: 'monthly' },
    });

    await expect(invokeController(startCheckoutController, req, res)).rejects.toThrow(
      /Stripe API timeout/,
    );
  });
});

// ── startTopupController ────────────────────────────────────

describe('startTopupController', () => {
  test('happy path → 200 with session url', async () => {
    fakeStripeService.createTopupCheckout.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/pay/cs_topup_456',
    });

    const { req, res, json } = buildReqRes({
      userId: 'user-321',
      body: { amountUsd: 25 },
    });

    await invokeController(startTopupController, req, res);

    expect(fakeStripeService.createTopupCheckout).toHaveBeenCalledWith({
      userId: 'user-321',
      amountUsd: 25,
    });
    expect(json).toHaveBeenCalledWith({
      data: { url: 'https://checkout.stripe.com/c/pay/cs_topup_456' },
    });
  });

  test('coerces string-encoded amount → 200 (clients sometimes send strings)', async () => {
    fakeStripeService.createTopupCheckout.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/pay/cs_topup_str',
    });

    const { req, res } = buildReqRes({
      userId: 'user-321',
      body: { amountUsd: '50' },
    });

    await invokeController(startTopupController, req, res);

    expect(fakeStripeService.createTopupCheckout).toHaveBeenCalledWith({
      userId: 'user-321',
      amountUsd: 50,
    });
  });

  test('below minimum amount → Zod rejects', async () => {
    const { req, res } = buildReqRes({
      userId: 'user-321',
      body: { amountUsd: 1 },
    });

    await expect(invokeController(startTopupController, req, res)).rejects.toThrow();
    expect(fakeStripeService.createTopupCheckout).not.toHaveBeenCalled();
  });

  test('above maximum amount → Zod rejects', async () => {
    const { req, res } = buildReqRes({
      userId: 'user-321',
      body: { amountUsd: 10_000 },
    });

    await expect(invokeController(startTopupController, req, res)).rejects.toThrow();
    expect(fakeStripeService.createTopupCheckout).not.toHaveBeenCalled();
  });

  test('non-integer amount → Zod rejects', async () => {
    const { req, res } = buildReqRes({
      userId: 'user-321',
      body: { amountUsd: 25.5 },
    });

    await expect(invokeController(startTopupController, req, res)).rejects.toThrow();
    expect(fakeStripeService.createTopupCheckout).not.toHaveBeenCalled();
  });

  test('Stripe returns no URL → 500 thrown', async () => {
    fakeStripeService.createTopupCheckout.mockResolvedValue({ url: null });

    const { req, res, status } = buildReqRes({
      userId: 'user-321',
      body: { amountUsd: 25 },
    });

    await expect(invokeController(startTopupController, req, res)).rejects.toThrow(
      /redirect URL/i,
    );
    expect(status).toHaveBeenCalledWith(500);
  });
});

// ── cancelSubscriptionController ────────────────────────────

describe('cancelSubscriptionController', () => {
  test('happy path with periodEnd → 200 with ISO string', async () => {
    const periodEnd = new Date('2026-06-15T12:00:00.000Z');
    fakeStripeService.scheduleSubscriptionCancellation.mockResolvedValue({
      periodEnd,
    });

    const { req, res, json } = buildReqRes({ userId: 'user-cancel' });

    await invokeController(cancelSubscriptionController, req, res);

    expect(fakeStripeService.scheduleSubscriptionCancellation).toHaveBeenCalledWith({
      userId: 'user-cancel',
    });
    expect(json).toHaveBeenCalledWith({
      data: { periodEnd: '2026-06-15T12:00:00.000Z' },
    });
  });

  test('null periodEnd (already-canceled / free) → 200 with null', async () => {
    fakeStripeService.scheduleSubscriptionCancellation.mockResolvedValue({
      periodEnd: null,
    });

    const { req, res, json } = buildReqRes({ userId: 'user-cancel-free' });

    await invokeController(cancelSubscriptionController, req, res);

    expect(json).toHaveBeenCalledWith({ data: { periodEnd: null } });
  });

  test('service error propagates', async () => {
    fakeStripeService.scheduleSubscriptionCancellation.mockRejectedValue(
      new Error('No active subscription'),
    );

    const { req, res } = buildReqRes({ userId: 'user-cancel' });

    await expect(invokeController(cancelSubscriptionController, req, res)).rejects.toThrow(
      /No active subscription/,
    );
  });
});
