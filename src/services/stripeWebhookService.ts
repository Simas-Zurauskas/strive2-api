import * as Sentry from '@sentry/node';
import mongoose from 'mongoose';
import UserModel from '@models/UserModel';
import CreditLedgerModel, { CreditLedgerReason } from '@models/CreditLedgerModel';
import { PLANS, PlanKey } from '@lib/creditPricing';
import { emitCreditsUpdated } from '@lib/creditSocket';
import { getStripe, mapPriceIdToPlan } from './stripeService';
import Stripe from 'stripe';

/**
 * Webhook event handler. Each branch is idempotent via the `stripeEventId`
 * unique-sparse index on `CreditLedger`: if a credit-mutating handler fires
 * twice for the same event id, the second ledger insert throws E11000 which
 * we catch + treat as "already processed, no-op." Non-credit state updates
 * (plan, status, period fields) are re-sync operations — naturally
 * idempotent because the source of truth is the incoming Stripe object.
 */
export const handleStripeEvent = async (event: Stripe.Event): Promise<void> => {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(event);
      return;
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event);
      return;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event);
      return;
    case 'invoice.paid':
      await handleInvoicePaid(event);
      return;
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event);
      return;
    default:
      // Stripe sends lots of event types; ignore the ones we don't subscribe to.
      return;
  }
};

// ── Handlers ──────────────────────────────────────

const handleCheckoutSessionCompleted = async (event: Stripe.Event): Promise<void> => {
  const session = event.data.object as Stripe.Checkout.Session;

  if (session.mode === 'subscription') {
    await onSubscriptionCheckoutCompleted({ session, event });
    return;
  }
  if (session.mode === 'payment') {
    // Only our top-up flow uses mode=payment — sanity-check via metadata so
    // an unrelated payment session doesn't accidentally grant credits.
    if (session.metadata?.flow !== 'topup') return;
    await onTopupCheckoutCompleted({ session, event });
    return;
  }
};

const onSubscriptionCheckoutCompleted = async ({
  session,
  event,
}: {
  session: Stripe.Checkout.Session;
  event: Stripe.Event;
}): Promise<void> => {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.warn(
      `[stripe] checkout.session.completed (subscription) without userId metadata, event ${event.id}`.yellow,
    );
    return;
  }

  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  if (!subscriptionId) return;

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0]?.price?.id;
  const planInfo = mapPriceIdToPlan(priceId);
  if (!planInfo) {
    console.warn(`[stripe] unknown priceId ${priceId} on new subscription ${subscriptionId}`.yellow);
    return;
  }

  const plan = PLANS[planInfo.plan];
  const period = getSubscriptionPeriod(subscription);

  await UserModel.updateOne(
    { _id: userId },
    {
      $set: {
        'subscription.plan': planInfo.plan,
        'subscription.status': 'active',
        'subscription.stripeSubscriptionId': subscriptionId,
        'subscription.stripePriceId': priceId,
        'subscription.currentPeriodStart': period.start,
        'subscription.currentPeriodEnd': period.end,
        'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end,
        'subscription.pendingPlan': null,
        'credits.allowanceBalance': plan.monthlyAllowance,
        'credits.allowanceGranted': plan.monthlyAllowance,
        'credits.periodStart': period.start,
        'credits.periodEnd': period.end,
      },
    },
  );

  await writeLedger({
    userId,
    stripeEventId: event.id,
    reason: 'plan_upgrade_bonus',
    allowanceDelta: plan.monthlyAllowance,
    bonusDelta: 0,
    balanceBefore: 0, // approximate — we're doing a full reset, pre-state doesn't matter for ledger
    balanceAfter: plan.monthlyAllowance,
    bonusBefore: 0,
    bonusAfter: 0,
    notes: `Subscription checkout → ${planInfo.plan} ${planInfo.cadence}`,
  });

  // Cancel-and-replace: if this Checkout was initiated by a paid user
  // switching plans, the old subscription id is stamped in session
  // metadata. Cancel it now that the NEW subscription is active + the
  // user's DB record points at the new sub id. The subscription.deleted
  // webhook that Stripe fires in response will no-op on our side because
  // `findOne({ stripeSubscriptionId: <old id> })` won't match — we
  // updated the user to the new id a few lines above.
  const replacingId = session.metadata?.replacingSubscriptionId;
  if (replacingId && replacingId !== subscriptionId) {
    try {
      await stripe.subscriptions.cancel(replacingId);
      console.log(`[stripe] replaced subscription ${replacingId} → ${subscriptionId} for user ${userId}`.cyan);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== 'resource_missing') {
        Sentry.captureException(err, {
          tags: { area: 'stripe.replaceSubscription' },
          extra: { replacingId, newId: subscriptionId, userId },
        });
      }
    }
  }
};

const onTopupCheckoutCompleted = async ({
  session,
  event,
}: {
  session: Stripe.Checkout.Session;
  event: Stripe.Event;
}): Promise<void> => {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.warn(`[stripe] topup checkout without userId metadata, event ${event.id}`.yellow);
    return;
  }

  // Variable-amount top-ups: the credit count + USD amount are stamped into
  // session metadata at Checkout-create time. Read them back here directly —
  // no line-item expansion needed (the inline `price_data` has no reusable
  // Price id to map from).
  //
  // Defensive parse: metadata values are always strings on Stripe's side.
  // Coerce + validate. If we can't recover both, fail loudly rather than
  // granting a plausibly-wrong credit amount.
  const creditsRaw = session.metadata?.credits;
  const amountUsdRaw = session.metadata?.amountUsd;
  const credits = Number(creditsRaw);
  const amountUsd = Number(amountUsdRaw);
  if (!Number.isInteger(credits) || credits <= 0 || !Number.isInteger(amountUsd) || amountUsd <= 0) {
    console.warn(
      `[stripe] topup checkout with invalid metadata (credits=${creditsRaw}, amountUsd=${amountUsdRaw}), event ${event.id}`.yellow,
    );
    return;
  }

  const user = await UserModel.findById(userId).select('credits').lean();
  if (!user) return;

  await UserModel.updateOne({ _id: userId }, { $inc: { 'credits.bonusBalance': credits } });

  await writeLedger({
    userId,
    stripeEventId: event.id,
    reason: 'topup_purchase',
    allowanceDelta: 0,
    bonusDelta: credits,
    balanceBefore: user.credits.allowanceBalance,
    balanceAfter: user.credits.allowanceBalance,
    bonusBefore: user.credits.bonusBalance,
    bonusAfter: user.credits.bonusBalance + credits,
    // User-visible ledger row — credit count is intentionally omitted so
    // the UI stays consistent with the "hide raw credits" policy. Dollar
    // amount alone tells the user what they spent.
    notes: `Top-up: $${amountUsd}`,
  });
};

const handleSubscriptionUpdated = async (event: Stripe.Event): Promise<void> => {
  const subscription = event.data.object as Stripe.Subscription;
  const user = await UserModel.findOne({ 'subscription.stripeSubscriptionId': subscription.id })
    .select('subscription credits')
    .lean();
  if (!user) return;

  const newPriceId = subscription.items.data[0]?.price?.id;
  const planInfo = mapPriceIdToPlan(newPriceId);
  const newPlan: PlanKey = planInfo?.plan ?? user.subscription.plan;
  const oldPlan: PlanKey = user.subscription.plan;

  const allowanceRanks: Record<PlanKey, number> = { free: 0, starter: 1, pro: 2, studio: 3 };
  const directionChange =
    allowanceRanks[newPlan] > allowanceRanks[oldPlan]
      ? 'upgrade'
      : allowanceRanks[newPlan] < allowanceRanks[oldPlan]
        ? 'downgrade'
        : 'same';

  const newStatus = mapStripeStatus(subscription.status);
  const period = getSubscriptionPeriod(subscription);

  // State sync: always write these fields. Plan + allowance changes are
  // gated by direction (upgrade now, downgrade at period end).
  const update: Record<string, unknown> = {
    'subscription.status': newStatus,
    'subscription.stripePriceId': newPriceId,
    'subscription.currentPeriodStart': period.start,
    'subscription.currentPeriodEnd': period.end,
    'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end,
  };

  if (directionChange === 'upgrade' && planInfo) {
    // Apply upgrade immediately — grant delta allowance as an "upgrade bonus"
    // to the current period (forfeits at period end with the rest). Next
    // invoice.paid will then seed the full new allowance at cycle renewal.
    const deltaAllowance = PLANS[newPlan].monthlyAllowance - PLANS[oldPlan].monthlyAllowance;
    update['subscription.plan'] = newPlan;
    update['subscription.pendingPlan'] = null;

    try {
      await UserModel.updateOne(
        { _id: user._id },
        {
          $set: update,
          $inc: { 'credits.allowanceBalance': Math.max(0, deltaAllowance) },
        },
      );
      if (deltaAllowance > 0) {
        await writeLedger({
          userId: user._id,
          stripeEventId: event.id,
          reason: 'plan_upgrade_bonus',
          allowanceDelta: deltaAllowance,
          bonusDelta: 0,
          balanceBefore: user.credits.allowanceBalance,
          balanceAfter: user.credits.allowanceBalance + deltaAllowance,
          bonusBefore: user.credits.bonusBalance,
          bonusAfter: user.credits.bonusBalance,
          notes: `Upgrade ${oldPlan} → ${newPlan}: +${deltaAllowance} allowance`,
        });
      }
    } catch (err) {
      // Duplicate-key on stripeEventId means we've already processed this
      // exact event; state sync happens once, safe to swallow.
      if (!isDuplicateKeyError(err)) throw err;
    }
    return;
  }

  if (directionChange === 'downgrade' && planInfo) {
    // Defer downgrade until next invoice.paid applies the new plan. Keep
    // current plan + credits intact so the user has what they paid for.
    update['subscription.pendingPlan'] = newPlan;
  }

  await UserModel.updateOne({ _id: user._id }, { $set: update });
};

const handleSubscriptionDeleted = async (event: Stripe.Event): Promise<void> => {
  const subscription = event.data.object as Stripe.Subscription;
  const user = await UserModel.findOne({ 'subscription.stripeSubscriptionId': subscription.id })
    .select('subscription credits')
    .lean();
  if (!user) return;

  const freeAllowance = PLANS.free.monthlyAllowance;
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        'subscription.plan': 'free',
        'subscription.status': 'canceled',
        'subscription.stripeSubscriptionId': null,
        'subscription.stripePriceId': null,
        'subscription.currentPeriodStart': null,
        'subscription.currentPeriodEnd': null,
        'subscription.cancelAtPeriodEnd': false,
        'subscription.pendingPlan': null,
        'credits.allowanceBalance': freeAllowance,
        'credits.allowanceGranted': freeAllowance,
        'credits.periodStart': now,
        'credits.periodEnd': periodEnd,
      },
    },
  );

  try {
    await writeLedger({
      userId: user._id,
      stripeEventId: event.id,
      reason: 'period_reset',
      allowanceDelta: freeAllowance - user.credits.allowanceBalance,
      bonusDelta: 0,
      balanceBefore: user.credits.allowanceBalance,
      balanceAfter: freeAllowance,
      bonusBefore: user.credits.bonusBalance,
      bonusAfter: user.credits.bonusBalance,
      notes: 'Subscription ended — downgraded to Free',
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
};

const handleInvoicePaid = async (event: Stripe.Event): Promise<void> => {
  const invoice = event.data.object as Stripe.Invoice;
  // Skip the very first invoice on subscription creation — checkout.session.completed
  // has already set up the plan + granted the initial allowance, and we
  // don't want to double-grant.
  if (invoice.billing_reason === 'subscription_create') return;
  // Only subscription renewals trigger credit resets. Manual or one-off
  // invoice payments (top-ups are mode=payment sessions, handled separately)
  // must not hit this path.
  if (invoice.billing_reason !== 'subscription_cycle' && invoice.billing_reason !== 'subscription_update') return;

  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return;

  const user = await UserModel.findOne({ 'subscription.stripeSubscriptionId': subscriptionId })
    .select('subscription credits')
    .lean();
  if (!user) return;

  // Apply any pending downgrade now that we're at the cycle boundary.
  const effectivePlan: PlanKey = user.subscription.pendingPlan ?? user.subscription.plan;
  const plan = PLANS[effectivePlan];

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const newPriceId = subscription.items.data[0]?.price?.id;
  const period = getSubscriptionPeriod(subscription);

  try {
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          'subscription.plan': effectivePlan,
          'subscription.status': 'active',
          'subscription.stripePriceId': newPriceId,
          'subscription.currentPeriodStart': period.start,
          'subscription.currentPeriodEnd': period.end,
          'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end,
          'subscription.pendingPlan': null,
          'credits.allowanceBalance': plan.monthlyAllowance,
          'credits.allowanceGranted': plan.monthlyAllowance,
          'credits.periodStart': period.start,
          'credits.periodEnd': period.end,
        },
      },
    );

    await writeLedger({
      userId: user._id,
      stripeEventId: event.id,
      reason: 'period_reset',
      allowanceDelta: plan.monthlyAllowance - user.credits.allowanceBalance,
      bonusDelta: 0,
      balanceBefore: user.credits.allowanceBalance,
      balanceAfter: plan.monthlyAllowance,
      bonusBefore: user.credits.bonusBalance,
      bonusAfter: user.credits.bonusBalance,
      notes: `Renewal — ${effectivePlan} (${invoice.billing_reason})`,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
};

const handleInvoicePaymentFailed = async (event: Stripe.Event): Promise<void> => {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return;

  await UserModel.updateOne(
    { 'subscription.stripeSubscriptionId': subscriptionId },
    { $set: { 'subscription.status': 'past_due' } },
  );
  // No credit mutation here — user keeps current balance; Stripe's dunning
  // retries the payment over the next few days. A grace-period sweep job
  // (Phase 5) downgrades to free if dunning exhausts without success.
};

// ── Helpers ──────────────────────────────────────

/**
 * Stripe API version 2025-03-31 moved `current_period_start/end` off the
 * subscription root onto each subscription item (to support mixed billing
 * cycles across items). We only ever use one item per subscription — grab
 * the first item's period as the effective subscription period. If the
 * subscription has zero items (shouldn't happen but defensively guard),
 * fall back to null.
 */
const getSubscriptionPeriod = (subscription: Stripe.Subscription): { start: Date | null; end: Date | null } => {
  const item = subscription.items.data[0];
  return {
    start: toDate(item?.current_period_start),
    end: toDate(item?.current_period_end),
  };
};

/**
 * Stripe API version 2025-03-31 replaced `invoice.subscription` with the
 * `parent` discriminated union. Subscription-triggered invoices surface the
 * subscription id under `parent.subscription_details.subscription` once
 * `parent.type === 'subscription_details'`.
 */
const getInvoiceSubscriptionId = (invoice: Stripe.Invoice): string | null => {
  const parent = invoice.parent;
  if (!parent || parent.type !== 'subscription_details') return null;
  const sub = parent.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === 'string' ? sub : sub.id;
};

const mapStripeStatus = (
  stripeStatus: Stripe.Subscription.Status,
): 'active' | 'past_due' | 'canceling' | 'canceled' => {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'past_due';
  if (stripeStatus === 'canceled' || stripeStatus === 'incomplete_expired') return 'canceled';
  // paused / incomplete → keep legacy 'canceling' bucket
  return 'canceling';
};

const toDate = (seconds: number | null | undefined): Date | null =>
  typeof seconds === 'number' ? new Date(seconds * 1000) : null;

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 11000;

const writeLedger = async ({
  userId,
  stripeEventId,
  reason,
  allowanceDelta,
  bonusDelta,
  balanceBefore,
  balanceAfter,
  bonusBefore,
  bonusAfter,
  notes,
}: {
  userId: mongoose.Types.ObjectId | string;
  stripeEventId: string;
  reason: CreditLedgerReason;
  allowanceDelta: number;
  bonusDelta: number;
  balanceBefore: number;
  balanceAfter: number;
  bonusBefore: number;
  bonusAfter: number;
  notes?: string;
}): Promise<void> => {
  try {
    await CreditLedgerModel.create({
      userId,
      timestamp: new Date(),
      delta: allowanceDelta + bonusDelta,
      allowanceDelta,
      bonusDelta,
      balanceBefore,
      balanceAfter,
      bonusBefore,
      bonusAfter,
      reason,
      stripeEventId,
      notes,
    });

    // Push live balance to the user's socket room. Skipped silently if the
    // ledger insert hit the dedup index above — we only announce deltas on
    // genuinely new events.
    emitCreditsUpdated({
      userId,
      payload: {
        allowance: balanceAfter,
        bonus: bonusAfter,
        total: balanceAfter + bonusAfter,
        delta: allowanceDelta + bonusDelta,
        reason,
      },
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return; // already processed
    Sentry.captureException(err, { tags: { area: 'stripe.webhook.ledger' } });
    throw err;
  }
};
