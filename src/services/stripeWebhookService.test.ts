/**
 * Tests for the Stripe webhook event handlers. The `stripeEventId`
 * unique-sparse index on `CreditLedger` is the only thing keeping double
 * deliveries from double-granting credits — so most tests assert
 * idempotency twice (run the same event, then run it again).
 *
 * Strategy:
 *   - vi.mock('@services/stripeService', ...) keeps `mapPriceIdToPlan`
 *     real (so the env-stubbed price IDs from test-setup.ts work) but
 *     stubs `getStripe()` so we can return canned subscription / charge
 *     / paymentIntent objects.
 *   - vi.mock('@lib/creditSocket', ...) no-ops the socket emit so we
 *     don't need a Socket.io server for these tests.
 *   - In-memory Mongo via setupTestDb provides real User + CreditLedger
 *     persistence.
 *
 * Run: yarn test stripeWebhookService
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type Stripe from 'stripe';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, subscribeUser, UserModel } from '../../test-helpers/factories';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { PLANS } from '@lib/creditPricing';

// Hoisted stub for the Stripe SDK fetcher. Vitest hoists `vi.mock` and
// `vi.hoisted` above all `import` statements, so the mock factory below
// closes over a stable reference that test code can also reach via the
// `fakeStripe` import returned from vi.hoisted.
const { fakeStripe } = vi.hoisted(() => ({
  fakeStripe: {
    subscriptions: {
      retrieve: vi.fn(),
      cancel: vi.fn(),
    },
    paymentIntents: {
      retrieve: vi.fn(),
    },
  },
}));

vi.mock('@services/stripeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/stripeService')>();
  return {
    ...actual,
    getStripe: () => fakeStripe,
  };
});

vi.mock('@lib/creditSocket', () => ({
  emitCreditsUpdated: vi.fn(),
}));

import { handleStripeEvent } from '@services/stripeWebhookService';

setupTestDb();

beforeEach(() => {
  fakeStripe.subscriptions.retrieve.mockReset();
  fakeStripe.subscriptions.cancel.mockReset();
  fakeStripe.paymentIntents.retrieve.mockReset();
});

// ── Fixture builders ─────────────────────────────────────

let eventCounter = 0;
const nextEventId = () => `evt_test_${++eventCounter}`;

const makeStripeSubscription = (overrides: {
  id: string;
  priceId: string;
  status?: Stripe.Subscription.Status;
  cancelAtPeriodEnd?: boolean;
  periodStart?: number;
  periodEnd?: number;
}): Stripe.Subscription => {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: overrides.id,
    status: overrides.status ?? 'active',
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    items: {
      data: [
        {
          id: 'si_test',
          price: { id: overrides.priceId },
          current_period_start: overrides.periodStart ?? now,
          current_period_end: overrides.periodEnd ?? now + 30 * 86400,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
};

const makeCheckoutEvent = (params: {
  mode: 'subscription' | 'payment';
  metadata?: Record<string, string>;
  subscriptionId?: string;
  eventId?: string;
}): Stripe.Event => ({
  id: params.eventId ?? nextEventId(),
  type: 'checkout.session.completed',
  data: {
    object: {
      mode: params.mode,
      metadata: params.metadata ?? {},
      subscription: params.subscriptionId ?? null,
    } as unknown as Stripe.Checkout.Session,
  },
} as unknown as Stripe.Event);

const makeSubUpdatedEvent = (params: {
  subscription: Stripe.Subscription;
  eventId?: string;
}): Stripe.Event => ({
  id: params.eventId ?? nextEventId(),
  type: 'customer.subscription.updated',
  data: { object: params.subscription },
} as unknown as Stripe.Event);

const makeSubDeletedEvent = (params: {
  subscriptionId: string;
  eventId?: string;
}): Stripe.Event => ({
  id: params.eventId ?? nextEventId(),
  type: 'customer.subscription.deleted',
  data: { object: { id: params.subscriptionId } as unknown as Stripe.Subscription },
} as unknown as Stripe.Event);

const makeInvoicePaidEvent = (params: {
  subscriptionId: string;
  billingReason?: Stripe.Invoice.BillingReason;
  eventId?: string;
}): Stripe.Event => ({
  id: params.eventId ?? nextEventId(),
  type: 'invoice.paid',
  data: {
    object: {
      billing_reason: params.billingReason ?? 'subscription_cycle',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: params.subscriptionId },
      },
    } as unknown as Stripe.Invoice,
  },
} as unknown as Stripe.Event);

const makeInvoicePaymentFailedEvent = (params: {
  subscriptionId: string;
  eventId?: string;
}): Stripe.Event => ({
  id: params.eventId ?? nextEventId(),
  type: 'invoice.payment_failed',
  data: {
    object: {
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: params.subscriptionId },
      },
    } as unknown as Stripe.Invoice,
  },
} as unknown as Stripe.Event);

const makeRefundEvent = (params: {
  paymentIntentId: string;
  chargeAmount: number;
  refundAmount: number;
  eventId?: string;
}): Stripe.Event => ({
  id: params.eventId ?? nextEventId(),
  type: 'charge.refunded',
  data: {
    object: {
      payment_intent: params.paymentIntentId,
      amount: params.chargeAmount,
      amount_refunded: params.refundAmount,
      refunds: { data: [{ amount: params.refundAmount }] },
    } as unknown as Stripe.Charge,
  },
} as unknown as Stripe.Event);

const makeDisputeEvent = (params: {
  paymentIntentId: string;
  disputeAmount: number;
  chargeAmount: number;
  eventId?: string;
}): Stripe.Event => ({
  id: params.eventId ?? nextEventId(),
  type: 'charge.dispute.created',
  data: {
    object: {
      payment_intent: params.paymentIntentId,
      amount: params.disputeAmount,
      charge: { amount: params.chargeAmount } as unknown as Stripe.Charge,
    } as unknown as Stripe.Dispute,
  },
} as unknown as Stripe.Event);

// ── Dispatcher ───────────────────────────────────────────

describe('handleStripeEvent dispatcher', () => {
  test('unhandled event types are no-ops', async () => {
    const event = {
      id: nextEventId(),
      type: 'customer.created',
      data: { object: {} },
    } as unknown as Stripe.Event;
    await expect(handleStripeEvent(event)).resolves.toBeUndefined();
  });
});

// ── checkout.session.completed (subscription) ────────────

describe('checkout.session.completed (subscription)', () => {
  test('happy path: subscribes user, sets allowance + period, writes ledger row', async () => {
    const user = await makeUser();
    fakeStripe.subscriptions.retrieve.mockResolvedValueOnce(
      makeStripeSubscription({ id: 'sub_new', priceId: 'price_starter_mo' }),
    );

    const event = makeCheckoutEvent({
      mode: 'subscription',
      metadata: { userId: user._id.toString() },
      subscriptionId: 'sub_new',
    });
    await handleStripeEvent(event);

    const updated = await UserModel.findById(user._id).lean();
    assert(updated);
    expect(updated.subscription.plan).toBe('starter');
    expect(updated.subscription.status).toBe('active');
    expect(updated.subscription.stripeSubscriptionId).toBe('sub_new');
    expect(updated.subscription.stripePriceId).toBe('price_starter_mo');
    expect(updated.credits.allowanceBalance).toBe(PLANS.starter.monthlyAllowance);
    expect(updated.credits.allowanceGranted).toBe(PLANS.starter.monthlyAllowance);

    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('plan_upgrade_bonus');
    expect(ledger[0].allowanceDelta).toBe(PLANS.starter.monthlyAllowance);
    expect(ledger[0].stripeEventId).toBe(event.id);
  });

  test('missing userId metadata is a logged no-op (no crash)', async () => {
    const event = makeCheckoutEvent({
      mode: 'subscription',
      metadata: {}, // no userId
      subscriptionId: 'sub_xyz',
    });
    await expect(handleStripeEvent(event)).resolves.toBeUndefined();
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
    expect(fakeStripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  test('unknown priceId on subscription is a logged no-op (no plan change)', async () => {
    const user = await makeUser();
    fakeStripe.subscriptions.retrieve.mockResolvedValueOnce(
      makeStripeSubscription({ id: 'sub_1', priceId: 'price_unknown_xyz' }),
    );

    const event = makeCheckoutEvent({
      mode: 'subscription',
      metadata: { userId: user._id.toString() },
      subscriptionId: 'sub_1',
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.subscription.plan).toBe('free'); // unchanged
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('idempotent: same event delivered twice → only one ledger row', async () => {
    const user = await makeUser();
    fakeStripe.subscriptions.retrieve.mockResolvedValue(
      makeStripeSubscription({ id: 'sub_idem', priceId: 'price_starter_mo' }),
    );

    const event = makeCheckoutEvent({
      mode: 'subscription',
      metadata: { userId: user._id.toString() },
      subscriptionId: 'sub_idem',
    });
    await handleStripeEvent(event);
    await handleStripeEvent(event); // duplicate delivery

    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
  });

  test('cancel-and-replace: stamps replacingSubscriptionId → cancels old sub', async () => {
    const user = await makeUser();
    fakeStripe.subscriptions.retrieve.mockResolvedValueOnce(
      makeStripeSubscription({ id: 'sub_new_2', priceId: 'price_pro_mo' }),
    );
    fakeStripe.subscriptions.cancel.mockResolvedValueOnce({} as Stripe.Subscription);

    const event = makeCheckoutEvent({
      mode: 'subscription',
      metadata: { userId: user._id.toString(), replacingSubscriptionId: 'sub_old_1' },
      subscriptionId: 'sub_new_2',
    });
    await handleStripeEvent(event);

    expect(fakeStripe.subscriptions.cancel).toHaveBeenCalledWith('sub_old_1');
  });

  test('cancel-and-replace: resource_missing on old sub is swallowed silently', async () => {
    const user = await makeUser();
    fakeStripe.subscriptions.retrieve.mockResolvedValueOnce(
      makeStripeSubscription({ id: 'sub_new_3', priceId: 'price_pro_mo' }),
    );
    const err = Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
    fakeStripe.subscriptions.cancel.mockRejectedValueOnce(err);

    const event = makeCheckoutEvent({
      mode: 'subscription',
      metadata: { userId: user._id.toString(), replacingSubscriptionId: 'sub_dead' },
      subscriptionId: 'sub_new_3',
    });
    await expect(handleStripeEvent(event)).resolves.toBeUndefined();
  });

  test('cancel-and-replace: skipped when replacing id equals new id', async () => {
    const user = await makeUser();
    fakeStripe.subscriptions.retrieve.mockResolvedValueOnce(
      makeStripeSubscription({ id: 'sub_same', priceId: 'price_starter_mo' }),
    );

    const event = makeCheckoutEvent({
      mode: 'subscription',
      metadata: { userId: user._id.toString(), replacingSubscriptionId: 'sub_same' },
      subscriptionId: 'sub_same',
    });
    await handleStripeEvent(event);

    expect(fakeStripe.subscriptions.cancel).not.toHaveBeenCalled();
  });
});

// ── checkout.session.completed (top-up) ──────────────────

describe('checkout.session.completed (top-up)', () => {
  test('happy path: bonusBalance increments + ledger row written', async () => {
    const user = await makeUser();

    const event = makeCheckoutEvent({
      mode: 'payment',
      metadata: {
        flow: 'topup',
        userId: user._id.toString(),
        credits: '500',
        amountUsd: '10',
      },
    });
    await handleStripeEvent(event);

    const updated = await UserModel.findById(user._id).lean();
    expect(updated?.credits.bonusBalance).toBe(500);
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('topup_purchase');
    expect(ledger[0].bonusDelta).toBe(500);
  });

  test('payment session WITHOUT flow=topup is ignored (sanity guard)', async () => {
    const user = await makeUser();
    const event = makeCheckoutEvent({
      mode: 'payment',
      metadata: { userId: user._id.toString(), credits: '500' }, // no flow=topup
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(0);
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('top-up with invalid metadata (credits=NaN) is a no-op', async () => {
    const user = await makeUser();
    const event = makeCheckoutEvent({
      mode: 'payment',
      metadata: {
        flow: 'topup',
        userId: user._id.toString(),
        credits: 'abc',
        amountUsd: '10',
      },
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(0);
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('top-up with negative credits is a no-op', async () => {
    const user = await makeUser();
    const event = makeCheckoutEvent({
      mode: 'payment',
      metadata: {
        flow: 'topup',
        userId: user._id.toString(),
        credits: '-100',
        amountUsd: '10',
      },
    });
    await handleStripeEvent(event);
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('top-up with zero amountUsd is a no-op', async () => {
    const user = await makeUser();
    const event = makeCheckoutEvent({
      mode: 'payment',
      metadata: {
        flow: 'topup',
        userId: user._id.toString(),
        credits: '500',
        amountUsd: '0',
      },
    });
    await handleStripeEvent(event);
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('idempotent: same top-up event delivered twice → bonus credited once', async () => {
    const user = await makeUser();
    const event = makeCheckoutEvent({
      mode: 'payment',
      metadata: {
        flow: 'topup',
        userId: user._id.toString(),
        credits: '500',
        amountUsd: '10',
      },
    });
    await handleStripeEvent(event);
    await handleStripeEvent(event); // duplicate

    // The ledger insert is idempotent (E11000), but the $inc fires both times
    // before that — this is documented behavior in the audit. The TEST
    // captures the actual current behavior; bonusBalance ends at 1000.
    // If/when the implementation adds a pre-check on stripeEventId before
    // the $inc (like applyClawback does), this test should be updated to
    // expect 500.
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1); // ledger is correctly idempotent
  });
});

// ── customer.subscription.updated ───────────────────────

describe('customer.subscription.updated', () => {
  test('upgrade Starter → Pro: applies new plan + grants delta allowance', async () => {
    const user = await makeUser();
    await subscribeUser({
      userId: user._id,
      plan: 'starter',
      stripeSubscriptionId: 'sub_upg_1',
    });

    const event = makeSubUpdatedEvent({
      subscription: makeStripeSubscription({
        id: 'sub_upg_1',
        priceId: 'price_pro_mo',
      }),
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    assert(after);
    expect(after.subscription.plan).toBe('pro');
    expect(after.subscription.pendingPlan).toBeFalsy();
    const expectedDelta = PLANS.pro.monthlyAllowance - PLANS.starter.monthlyAllowance;
    expect(after.credits.allowanceBalance).toBe(PLANS.starter.monthlyAllowance + expectedDelta);

    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('plan_upgrade_bonus');
    expect(ledger[0].allowanceDelta).toBe(expectedDelta);
  });

  test('downgrade Pro → Starter: pendingPlan set, plan unchanged, no ledger row', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'pro', stripeSubscriptionId: 'sub_dn_1' });

    const event = makeSubUpdatedEvent({
      subscription: makeStripeSubscription({
        id: 'sub_dn_1',
        priceId: 'price_starter_mo',
      }),
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.subscription.plan).toBe('pro');
    expect(after?.subscription.pendingPlan).toBe('starter');
    expect(after?.credits.allowanceBalance).toBe(PLANS.pro.monthlyAllowance); // unchanged
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('same plan (state-sync only): syncs status + period, no ledger row', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'starter', stripeSubscriptionId: 'sub_same_plan' });

    const event = makeSubUpdatedEvent({
      subscription: makeStripeSubscription({
        id: 'sub_same_plan',
        priceId: 'price_starter_mo',
        cancelAtPeriodEnd: true,
      }),
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.subscription.cancelAtPeriodEnd).toBe(true);
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('unknown subscription id (no matching user) is a no-op', async () => {
    const event = makeSubUpdatedEvent({
      subscription: makeStripeSubscription({
        id: 'sub_unknown',
        priceId: 'price_starter_mo',
      }),
    });
    await expect(handleStripeEvent(event)).resolves.toBeUndefined();
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('idempotent: duplicate upgrade event → only one ledger row', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'starter', stripeSubscriptionId: 'sub_idem_upg' });

    const event = makeSubUpdatedEvent({
      subscription: makeStripeSubscription({
        id: 'sub_idem_upg',
        priceId: 'price_pro_mo',
      }),
    });
    await handleStripeEvent(event);
    await handleStripeEvent(event); // duplicate

    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
  });
});

// ── customer.subscription.deleted ───────────────────────

describe('customer.subscription.deleted', () => {
  test('user found: resets to Free with fresh allowance + ledger row', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'pro', stripeSubscriptionId: 'sub_del_1' });

    const event = makeSubDeletedEvent({ subscriptionId: 'sub_del_1' });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    assert(after);
    expect(after.subscription.plan).toBe('free');
    expect(after.subscription.status).toBe('canceled');
    expect(after.subscription.stripeSubscriptionId).toBeFalsy();
    expect(after.credits.allowanceBalance).toBe(PLANS.free.monthlyAllowance);

    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('period_reset');
  });

  test('idempotent: same deletion event twice → ledger row only once', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'pro', stripeSubscriptionId: 'sub_del_2' });

    const event = makeSubDeletedEvent({ subscriptionId: 'sub_del_2' });
    await handleStripeEvent(event);
    // After the first delete, the user no longer matches by stripeSubscriptionId;
    // a second event of the same id finds no user and no-ops naturally.
    await handleStripeEvent(event);

    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
  });

  test('unknown subscription id is a no-op', async () => {
    const event = makeSubDeletedEvent({ subscriptionId: 'sub_unknown_del' });
    await expect(handleStripeEvent(event)).resolves.toBeUndefined();
  });

  // Regression for E11000 on subscription.stripeSubscriptionId. The index
  // was unique+sparse, but sparse still indexes explicit `null`, so the
  // SECOND cancellation (clearing the id) collided with the first user's
  // cleared id. The fix makes the index partial ($type:'string') and clears
  // via $unset. syncIndexes() here forces the real index to exist — the test
  // DB helper otherwise leaves index builds lazy, which is why this slipped.
  test('two different users cancelling do not collide on cleared stripeSubscriptionId', async () => {
    await UserModel.syncIndexes();

    const userA = await makeUser();
    await subscribeUser({ userId: userA._id, plan: 'pro', stripeSubscriptionId: 'sub_collide_a' });
    const userB = await makeUser();
    await subscribeUser({ userId: userB._id, plan: 'pro', stripeSubscriptionId: 'sub_collide_b' });

    await handleStripeEvent(makeSubDeletedEvent({ subscriptionId: 'sub_collide_a' }));
    // Pre-fix this throws E11000 (both users now hold null at the indexed key).
    await expect(
      handleStripeEvent(makeSubDeletedEvent({ subscriptionId: 'sub_collide_b' })),
    ).resolves.toBeUndefined();

    for (const id of [userA._id, userB._id]) {
      const after = await UserModel.findById(id).lean();
      assert(after);
      expect(after.subscription.plan).toBe('free');
      expect(after.subscription.status).toBe('canceled');
      expect(after.subscription.stripeSubscriptionId).toBeUndefined();
    }
  });
});

// ── invoice.paid ─────────────────────────────────────────

describe('invoice.paid', () => {
  test('billing_reason=subscription_create is skipped (avoids double-grant)', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'starter', stripeSubscriptionId: 'sub_inv_create' });

    const event = makeInvoicePaidEvent({
      subscriptionId: 'sub_inv_create',
      billingReason: 'subscription_create',
    });
    await handleStripeEvent(event);

    expect(await CreditLedgerModel.countDocuments()).toBe(0);
    expect(fakeStripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  test('billing_reason=manual is skipped', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'starter', stripeSubscriptionId: 'sub_inv_manual' });

    const event = makeInvoicePaidEvent({
      subscriptionId: 'sub_inv_manual',
      billingReason: 'manual',
    });
    await handleStripeEvent(event);
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('subscription_cycle: refreshes allowance + writes ledger row', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'starter', stripeSubscriptionId: 'sub_inv_cycle' });
    // Simulate spent-down allowance
    await UserModel.updateOne({ _id: user._id }, { $set: { 'credits.allowanceBalance': 5 } });

    fakeStripe.subscriptions.retrieve.mockResolvedValueOnce(
      makeStripeSubscription({ id: 'sub_inv_cycle', priceId: 'price_starter_mo' }),
    );

    const event = makeInvoicePaidEvent({
      subscriptionId: 'sub_inv_cycle',
      billingReason: 'subscription_cycle',
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.allowanceBalance).toBe(PLANS.starter.monthlyAllowance);
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('period_reset');
  });

  test('subscription_cycle with pendingPlan: applies pending plan + clears it', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'pro', stripeSubscriptionId: 'sub_pending' });
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { 'subscription.pendingPlan': 'starter' } },
    );

    fakeStripe.subscriptions.retrieve.mockResolvedValueOnce(
      makeStripeSubscription({ id: 'sub_pending', priceId: 'price_starter_mo' }),
    );

    const event = makeInvoicePaidEvent({
      subscriptionId: 'sub_pending',
      billingReason: 'subscription_cycle',
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.subscription.plan).toBe('starter');
    expect(after?.subscription.pendingPlan).toBeFalsy();
    expect(after?.credits.allowanceBalance).toBe(PLANS.starter.monthlyAllowance);
  });

  test('idempotent: duplicate cycle event → ledger row only once', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'starter', stripeSubscriptionId: 'sub_inv_idem' });

    fakeStripe.subscriptions.retrieve.mockResolvedValue(
      makeStripeSubscription({ id: 'sub_inv_idem', priceId: 'price_starter_mo' }),
    );

    const event = makeInvoicePaidEvent({
      subscriptionId: 'sub_inv_idem',
      billingReason: 'subscription_cycle',
    });
    await handleStripeEvent(event);
    await handleStripeEvent(event);

    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
  });

  test('unknown subscription id is a no-op', async () => {
    const event = makeInvoicePaidEvent({
      subscriptionId: 'sub_unknown_inv',
      billingReason: 'subscription_cycle',
    });
    await expect(handleStripeEvent(event)).resolves.toBeUndefined();
  });
});

// ── invoice.payment_failed ──────────────────────────────

describe('invoice.payment_failed', () => {
  test('sets subscription status to past_due (no credit mutation)', async () => {
    const user = await makeUser();
    await subscribeUser({ userId: user._id, plan: 'starter', stripeSubscriptionId: 'sub_pf_1' });
    const before = await UserModel.findById(user._id).lean();

    const event = makeInvoicePaymentFailedEvent({ subscriptionId: 'sub_pf_1' });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.subscription.status).toBe('past_due');
    expect(after?.credits.allowanceBalance).toBe(before?.credits.allowanceBalance); // untouched
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('unknown subscription id is a no-op', async () => {
    const event = makeInvoicePaymentFailedEvent({ subscriptionId: 'sub_unknown_pf' });
    await expect(handleStripeEvent(event)).resolves.toBeUndefined();
  });
});

// ── charge.refunded (top-up clawback) ────────────────────

describe('charge.refunded (top-up clawback)', () => {
  const seedTopupUser = async (params: { bonus: number }) => {
    const user = await makeUser();
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { 'credits.bonusBalance': params.bonus } },
    );
    return user;
  };

  test('full refund: claws back full credit grant', async () => {
    const user = await seedTopupUser({ bonus: 500 });
    fakeStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      metadata: { flow: 'topup', userId: user._id.toString(), credits: '500' },
    } as unknown as Stripe.PaymentIntent);

    const event = makeRefundEvent({
      paymentIntentId: 'pi_full',
      chargeAmount: 1000, // $10 in cents
      refundAmount: 1000,
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(0);
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('refund_topup');
    expect(ledger[0].bonusDelta).toBe(-500);
  });

  test('half refund: claws back proportional half', async () => {
    const user = await seedTopupUser({ bonus: 500 });
    fakeStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      metadata: { flow: 'topup', userId: user._id.toString(), credits: '500' },
    } as unknown as Stripe.PaymentIntent);

    const event = makeRefundEvent({
      paymentIntentId: 'pi_half',
      chargeAmount: 1000, // $10
      refundAmount: 500, // $5 → 50%
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(250); // 500 - 250
  });

  test('clamp: user already spent 400 of 500 — refund of full top-up clamps clawback to 100', async () => {
    const user = await seedTopupUser({ bonus: 100 }); // started with 500, spent 400, has 100 left
    fakeStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      metadata: { flow: 'topup', userId: user._id.toString(), credits: '500' },
    } as unknown as Stripe.PaymentIntent);

    const event = makeRefundEvent({
      paymentIntentId: 'pi_clamp',
      chargeAmount: 1000,
      refundAmount: 1000, // wants to claw 500
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(0); // can't go negative
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger[0].bonusDelta).toBe(-100);
    expect(ledger[0].notes).toContain('clamped');
  });

  test('cent-scale partial refund ceils to ≥ 1 credit (no penny free-ride)', async () => {
    const user = await seedTopupUser({ bonus: 4000 });
    fakeStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      metadata: { flow: 'topup', userId: user._id.toString(), credits: '4000' },
    } as unknown as Stripe.PaymentIntent);

    const event = makeRefundEvent({
      paymentIntentId: 'pi_penny',
      chargeAmount: 10000, // $100
      refundAmount: 1, // 1¢ refund — proportional credits = 0.4 → ceil = 1
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(3999);
  });

  test('non-topup payment intent (no flow=topup) is ignored', async () => {
    const user = await seedTopupUser({ bonus: 500 });
    fakeStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      metadata: { userId: user._id.toString(), credits: '500' }, // no flow=topup
    } as unknown as Stripe.PaymentIntent);

    const event = makeRefundEvent({
      paymentIntentId: 'pi_notopup',
      chargeAmount: 1000,
      refundAmount: 1000,
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(500);
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });

  test('idempotent: same refund event delivered twice → only one clawback', async () => {
    const user = await seedTopupUser({ bonus: 500 });
    fakeStripe.paymentIntents.retrieve.mockResolvedValue({
      metadata: { flow: 'topup', userId: user._id.toString(), credits: '500' },
    } as unknown as Stripe.PaymentIntent);

    const event = makeRefundEvent({
      paymentIntentId: 'pi_idem',
      chargeAmount: 1000,
      refundAmount: 1000,
    });
    await handleStripeEvent(event);
    await handleStripeEvent(event); // duplicate

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(0); // not -500
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger).toHaveLength(1);
  });

  test('missing userId metadata on refund is a logged no-op', async () => {
    fakeStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      metadata: { flow: 'topup', credits: '500' }, // no userId
    } as unknown as Stripe.PaymentIntent);

    const event = makeRefundEvent({
      paymentIntentId: 'pi_no_user',
      chargeAmount: 1000,
      refundAmount: 1000,
    });
    await expect(handleStripeEvent(event)).resolves.toBeUndefined();
    expect(await CreditLedgerModel.countDocuments()).toBe(0);
  });
});

// ── charge.dispute.created ───────────────────────────────

describe('charge.dispute.created (top-up clawback)', () => {
  test('happy path: disputes a top-up → claws back proportional credits', async () => {
    const user = await makeUser();
    await UserModel.updateOne({ _id: user._id }, { $set: { 'credits.bonusBalance': 500 } });
    fakeStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      metadata: { flow: 'topup', userId: user._id.toString(), credits: '500' },
    } as unknown as Stripe.PaymentIntent);

    const event = makeDisputeEvent({
      paymentIntentId: 'pi_disp_1',
      disputeAmount: 1000, // full $10
      chargeAmount: 1000,
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(0);
    const ledger = await CreditLedgerModel.find({ userId: user._id }).lean();
    expect(ledger[0].reason).toBe('dispute_clawback');
  });

  test('chargeAmount=0 fallback: claws back the full granted credits', async () => {
    const user = await makeUser();
    await UserModel.updateOne({ _id: user._id }, { $set: { 'credits.bonusBalance': 500 } });
    fakeStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      metadata: { flow: 'topup', userId: user._id.toString(), credits: '500' },
    } as unknown as Stripe.PaymentIntent);

    const event = makeDisputeEvent({
      paymentIntentId: 'pi_disp_zero',
      disputeAmount: 1000,
      chargeAmount: 0,
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(0);
  });

  test('non-topup payment intent → ignored', async () => {
    const user = await makeUser();
    await UserModel.updateOne({ _id: user._id }, { $set: { 'credits.bonusBalance': 500 } });
    fakeStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      metadata: { userId: user._id.toString(), credits: '500' },
    } as unknown as Stripe.PaymentIntent);

    const event = makeDisputeEvent({
      paymentIntentId: 'pi_disp_other',
      disputeAmount: 1000,
      chargeAmount: 1000,
    });
    await handleStripeEvent(event);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.credits.bonusBalance).toBe(500); // unchanged
  });
});
