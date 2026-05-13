import mongoose, { ClientSession } from 'mongoose';
import UserModel from '@models/UserModel';
import CreditLedgerModel, { CreditLedgerReason } from '@models/CreditLedgerModel';
import { FREE_PERIOD_DAYS, PLANS, PlanKey } from '@lib/creditPricing';
import { emitCreditsUpdated } from '@lib/creditSocket';
import { monetizationLog } from '@lib/loggers';
import { captureError } from '@lib/errorReporter';
import { analytics } from '@lib/analytics';
import { withCreditTransaction } from '@lib/dbTransaction';
import { getStripe, mapPriceIdToPlan } from './stripeService';
import Stripe from 'stripe';

/**
 * Stripe encodes "subscription will end at a future date" in two equivalent
 * ways depending on how the cancel was triggered:
 *   - boolean `cancel_at_period_end: true` — set when our API calls
 *     `stripe.subscriptions.update(..., { cancel_at_period_end: true })`
 *   - timestamp `cancel_at: <unix>` — set when the user cancels through the
 *     Stripe-hosted billing portal (timestamp = period end)
 * Either truthy value means the subscription is in the "canceling" state from
 * our DB and UI perspective. Reading only one of them caused portal cancels
 * to be silently dropped.
 */
const isSubscriptionCancelling = (
  sub: Pick<Stripe.Subscription, 'cancel_at_period_end' | 'cancel_at'>,
): boolean => sub.cancel_at_period_end === true || sub.cancel_at != null;

/**
 * Throw this from a handler when an error is transient — a Mongo replica-set
 * blip, an outbound vendor 503, etc. The webhook controller treats it as
 * "ask Stripe to retry us" (5xx response). Anything else thrown from a
 * handler is treated as deterministic and acknowledged to break the retry
 * loop (logged + captured to Sentry; reconciliation cron handles drift).
 */
export class RetryableWebhookError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RetryableWebhookError';
  }
}

/**
 * Translate a low-level error into RetryableWebhookError when it looks
 * transient. Mongoose drivers throw `MongoNetworkError`, `MongoServerError`
 * with codes like 11600 (interrupted) etc. — all retryable.
 */
const isTransientError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  if (name === 'MongoNetworkError' || name === 'MongoTimeoutError' || name === 'MongoNotConnectedError') return true;
  // Mongo "transient" labels surface as code or codeName depending on driver version.
  const codeName = (err as { codeName?: string }).codeName;
  if (codeName === 'NotWritablePrimary' || codeName === 'InterruptedAtShutdown') return true;
  return false;
};

/**
 * Webhook event handler. Each branch is idempotent via the `stripeEventId`
 * unique-sparse index on `CreditLedger`: if a credit-mutating handler fires
 * twice for the same event id, the second ledger insert throws E11000 which
 * we catch + treat as "already processed, no-op." Non-credit state updates
 * (plan, status, period fields) are re-sync operations — naturally
 * idempotent because the source of truth is the incoming Stripe object.
 */
export const handleStripeEvent = async (event: Stripe.Event): Promise<void> => {
  monetizationLog.info(`Webhook received: ${event.type} (${event.id})`);
  try {
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
      case 'charge.refunded':
        await handleChargeRefunded(event);
        return;
      case 'charge.dispute.created':
        await handleChargeDisputeCreated(event);
        return;
      default:
        // Stripe sends lots of event types; ignore the ones we don't subscribe to.
        return;
    }
  } catch (err) {
    if (err instanceof RetryableWebhookError) throw err;
    if (isTransientError(err)) {
      throw new RetryableWebhookError(`Transient handler failure: ${err instanceof Error ? err.message : String(err)}`, err);
    }
    throw err;
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
    monetizationLog.warn(`Subscription checkout without userId metadata, event ${event.id}`);
    return;
  }

  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  if (!subscriptionId) {
    monetizationLog.warn(
      `Subscription checkout session without subscription id (mode=${session.mode}, payment_status=${session.payment_status}), event ${event.id}`,
    );
    return;
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0]?.price?.id;
  const planInfo = mapPriceIdToPlan(priceId);
  if (!planInfo) {
    monetizationLog.warn(`Unknown priceId ${priceId} on new subscription ${subscriptionId}`);
    return;
  }

  const plan = PLANS[planInfo.plan];
  const period = getSubscriptionPeriod(subscription);

  // Idempotency: pre-check stripeEventId BEFORE the allowance reset. Without
  // this, a Stripe redelivery of the same `checkout.session.completed` would
  // re-reset `allowanceBalance` to the plan's monthly grant, refilling any
  // credits the user has spent in the meantime. The ledger insert at the end
  // would then trip E11000, but the damage (the refill) has already happened.
  // Mirrors `onTopupCheckoutCompleted` and the `handleSubscriptionUpdated`
  // upgrade branch.
  const existing = await CreditLedgerModel.findOne({ stripeEventId: event.id }).select('_id').lean();
  if (existing) {
    monetizationLog.info(`Duplicate subscription checkout event ${event.id}, skipping`);
    return;
  }

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
        'subscription.cancelAtPeriodEnd': isSubscriptionCancelling(subscription),
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

  monetizationLog.info(
    `Subscription activated: user=${userId} plan=${planInfo.plan}/${planInfo.cadence} allowance=${plan.monthlyAllowance}`,
  );

  // Cancel-and-replace: if this Checkout was initiated by a paid user
  // switching plans, the old subscription id is stamped in session
  // metadata. Cancel it now that the NEW subscription is active + the
  // user's DB record points at the new sub id. The subscription.deleted
  // webhook that Stripe fires in response will no-op on our side because
  // `findOne({ stripeSubscriptionId: <old id> })` won't match — we
  // updated the user to the new id a few lines above.
  const replacingId = session.metadata?.replacingSubscriptionId;

  // Mixpanel: subscription checkout completed. `intent` distinguishes
  // first-time conversion ("new") from a paid-to-paid plan change
  // initiated via Checkout ("upgrade"). Cents-level fields use the
  // `*_usd_cents` suffix per the property convention; `amount_usd`
  // mirrors as a decimal for dashboard readability.
  analytics.setUserProps(userId, {
    plan: planInfo.plan,
    billing_cycle: planInfo.cadence,
  });
  const totalCents = session.amount_total ?? 0;
  analytics.track(userId, 'checkout_completed', {
    plan: planInfo.plan,
    cycle: planInfo.cadence,
    intent: replacingId && replacingId !== subscriptionId ? 'upgrade' : 'new',
    amount_usd_cents: totalCents,
    amount_usd: Number((totalCents / 100).toFixed(2)),
    currency: session.currency ?? 'usd',
  });
  if (replacingId && replacingId !== subscriptionId) {
    try {
      await stripe.subscriptions.cancel(replacingId);
      monetizationLog.info(`Replaced subscription ${replacingId} → ${subscriptionId} for user=${userId}`);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      // `resource_missing` is the idempotent self-short-circuit — the
      // subscription was already cancelled (often by an earlier webhook
      // delivery), nothing to do.
      if (code === 'resource_missing') return;

      // Transient Stripe failures (network blip, 429 rate-limit, 5xx)
      // would previously be Sentry-captured + swallowed — leaving BOTH
      // the old AND new subscription billing because the cancel never
      // landed. Promote them to RetryableWebhookError so the webhook
      // controller returns 5xx and Stripe retries the entire event
      // (idempotent now that C1's pre-checks short-circuit duplicate
      // ledger inserts).
      if (isTransientStripeError(err)) {
        throw new RetryableWebhookError(
          `Transient failure cancelling replaced subscription ${replacingId}`,
          err,
        );
      }

      // Deterministic Stripe errors (invalid_request_error etc.) — log
      // and continue. Manual reconciliation needed; loud Sentry breadcrumb
      // surfaces the case.
      captureError(err, {
        tags: { area: 'stripe.replaceSubscription' },
        extra: { replacingId, newId: subscriptionId, userId },
        fingerprint: ['stripe', 'replaceSubscription'],
      });
    }
  }
};

/**
 * Classify a Stripe SDK error as transient (worth retrying) or deterministic
 * (manual review). Used by handlers where a retry would be safe AND useful.
 *
 * Transient: network errors, 429 rate-limit, 5xx server errors, 408 timeout.
 * Deterministic: 4xx client errors (validation, missing resource, etc.).
 */
const isTransientStripeError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { type?: string; statusCode?: number; code?: string };
  if (e.type === 'StripeConnectionError') return true;
  if (e.type === 'StripeRateLimitError') return true;
  if (typeof e.statusCode === 'number' && (e.statusCode >= 500 || e.statusCode === 408 || e.statusCode === 429)) {
    return true;
  }
  return false;
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
    monetizationLog.warn(`Top-up checkout without userId metadata, event ${event.id}`);
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
    monetizationLog.warn(
      `Top-up checkout with invalid metadata (credits=${creditsRaw}, amountUsd=${amountUsdRaw}), event ${event.id}`,
    );
    return;
  }

  // Idempotency: pre-check the unique stripeEventId on CreditLedger BEFORE
  // running the `$inc`. Stripe retries (and concurrent duplicate deliveries)
  // would otherwise increment the bonus balance twice, with only the second
  // ledger insert tripping E11000 — the first $inc would have already gone
  // through. Mirrors `applyClawback` below.
  const existing = await CreditLedgerModel.findOne({ stripeEventId: event.id }).select('_id').lean();
  if (existing) {
    monetizationLog.info(`Top-up: duplicate event ${event.id}, skipping`);
    return;
  }

  const user = await UserModel.findById(userId).select('credits').lean();
  if (!user) return;

  // Atomic: $inc + ledger insert commit together (or roll back together) so a
  // transient ledger-write failure can't leave the bonus $inc applied while
  // Stripe retries the webhook — the prior pattern leaked a double-grant by
  // the time the retry's pre-check fired (the first $inc had landed, the
  // ledger row hadn't, so the retry's pre-check missed and $inc'd again).
  // E11000 from the ledger insert means a concurrent racing duplicate slipped
  // past the pre-check; abort the transaction so $inc rolls back.
  const ledgerArgs: LedgerArgs = {
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
  };

  try {
    await withCreditTransaction(async (session) => {
      await UserModel.updateOne(
        { _id: userId },
        { $inc: { 'credits.bonusBalance': credits } },
        session ? { session } : undefined,
      );
      await insertLedgerRow(ledgerArgs, session);
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      monetizationLog.info(`Top-up: duplicate event race ${event.id}, transaction rolled back`);
      return;
    }
    throw err;
  }

  emitLedgerSocket(ledgerArgs);

  monetizationLog.info(
    `Top-up purchased: user=${userId} credits=+${credits} amount=$${amountUsd} bonus=${user.credits.bonusBalance}→${user.credits.bonusBalance + credits}`,
  );

  analytics.track(userId, 'checkout_completed', {
    intent: 'topup',
    topup_amount_usd: amountUsd,
    amount_usd_cents: amountUsd * 100,
    amount_usd: amountUsd,
  });
  analytics.track(userId, 'topup_purchased', {
    amount_usd: amountUsd,
    amount_usd_cents: amountUsd * 100,
    credits_granted: credits,
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
    'subscription.cancelAtPeriodEnd': isSubscriptionCancelling(subscription),
  };

  if (directionChange === 'upgrade' && planInfo) {
    // Apply upgrade immediately — grant delta allowance as an "upgrade bonus"
    // to the current period (forfeits at period end with the rest). Next
    // invoice.paid will then seed the full new allowance at cycle renewal.
    const deltaAllowance = PLANS[newPlan].monthlyAllowance - PLANS[oldPlan].monthlyAllowance;
    update['subscription.plan'] = newPlan;
    update['subscription.pendingPlan'] = null;

    // Idempotency: pre-check stripeEventId BEFORE the `$inc`. Without this,
    // a duplicate webhook delivery would double-credit the upgrade bonus
    // (the first delivery's $inc is already applied; only the second's
    // ledger-insert hits E11000). Mirrors `applyClawback`.
    const existing = await CreditLedgerModel.findOne({ stripeEventId: event.id }).select('_id').lean();
    if (existing) {
      monetizationLog.info(`Duplicate subscription.updated event ${event.id}, skipping`);
      // We still want the state-sync `$set` to be idempotently applied, so
      // run the update without the $inc on duplicate.
      await UserModel.updateOne({ _id: user._id }, { $set: update });
      return;
    }

    // Atomic: $set + $inc + ledger insert commit/roll back as a unit. Same
    // motivation as the top-up branch — without the transaction, a transient
    // ledger-write failure leaves the $inc applied; Stripe redelivers; the
    // pre-check above misses (because no ledger row exists for the event id);
    // the $inc fires again — double bonus.
    const ledgerArgs: LedgerArgs | null =
      deltaAllowance > 0
        ? {
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
          }
        : null;

    try {
      await withCreditTransaction(async (session) => {
        await UserModel.updateOne(
          { _id: user._id },
          {
            $set: update,
            $inc: { 'credits.allowanceBalance': Math.max(0, deltaAllowance) },
          },
          session ? { session } : undefined,
        );
        if (ledgerArgs) {
          await insertLedgerRow(ledgerArgs, session);
        }
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        monetizationLog.info(`Plan upgrade: duplicate event race ${event.id}, transaction rolled back`);
        return;
      }
      throw err;
    }

    if (ledgerArgs) emitLedgerSocket(ledgerArgs);

    monetizationLog.info(`Plan upgraded: user=${user._id} ${oldPlan}→${newPlan} bonus=+${deltaAllowance} allowance`);
    analytics.setUserProps(user._id.toString(), {
      plan: newPlan,
      billing_cycle: planInfo.cadence,
    });
    analytics.track(user._id.toString(), 'plan_upgraded', {
      from_plan: oldPlan,
      to_plan: newPlan,
      cycle: planInfo.cadence,
    });
    return;
  }

  if (directionChange === 'downgrade' && planInfo) {
    // Defer downgrade until next invoice.paid applies the new plan. Keep
    // current plan + credits intact so the user has what they paid for.
    update['subscription.pendingPlan'] = newPlan;
    monetizationLog.info(`Downgrade scheduled: user=${user._id} ${oldPlan}→${newPlan} (applies at next renewal)`);
    analytics.track(user._id.toString(), 'plan_downgrade_scheduled', {
      from_plan: oldPlan,
      to_plan: newPlan,
      ...(period.end && { effective_at: period.end.toISOString() }),
    });
  }

  // Detect a fresh transition into the "canceling" state via Stripe's
  // `previous_attributes` envelope. Without the previous-value compare we'd
  // fire `plan_cancelled` on every status update for an already-cancelling
  // subscription. Reads both `cancel_at_period_end` (programmatic cancel)
  // and `cancel_at` (portal cancel) — see isSubscriptionCancelling for why.
  const previousAttrs = (event.data as { previous_attributes?: Partial<Stripe.Subscription> })
    .previous_attributes;
  const cancelFieldChanged =
    previousAttrs && ('cancel_at_period_end' in previousAttrs || 'cancel_at' in previousAttrs);
  const wasCancellingBefore = cancelFieldChanged
    ? previousAttrs!.cancel_at_period_end === true || previousAttrs!.cancel_at != null
    : isSubscriptionCancelling(subscription);
  const becameCancelling = isSubscriptionCancelling(subscription) && !wasCancellingBefore;
  if (becameCancelling) {
    const tenureDays = (() => {
      const created = subscription.start_date ? new Date(subscription.start_date * 1000) : null;
      if (!created) return undefined;
      return Math.max(0, Math.floor((Date.now() - created.getTime()) / (24 * 60 * 60 * 1000)));
    })();
    analytics.track(user._id.toString(), 'plan_cancelled', {
      plan: oldPlan,
      ...(period.end && { effective_at: period.end.toISOString() }),
      ...(tenureDays !== undefined && { tenure_days: tenureDays }),
    });
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
  // FREE_PERIOD_DAYS lives in pricingConfig (KNOB 7) and is the single
  // source of truth for the Free-tier rollover window. Kept in sync with
  // the lazy reset path in creditService.applyFreePeriodReset.
  const periodEnd = new Date(now.getTime() + FREE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

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
    monetizationLog.info(`Subscription canceled: user=${user._id} → Free (allowance reset to ${freeAllowance})`);
    analytics.setUserProps(user._id.toString(), { plan: 'free', billing_cycle: null });
    analytics.track(user._id.toString(), 'account_downgraded_to_free', {
      cause: 'cancellation_period_ended',
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    monetizationLog.info(`Duplicate subscription.deleted event ${event.id}, skipping`);
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

  // Idempotency: pre-check stripeEventId BEFORE the allowance reset. A Stripe
  // redelivery of `invoice.paid` would otherwise re-reset `allowanceBalance`
  // to `plan.monthlyAllowance`, refilling credits the user has already spent
  // in the period. The catch below only handles E11000 — by the time the
  // ledger throws, the `$set` has already landed. Mirrors the pre-check in
  // `onSubscriptionCheckoutCompleted` and `handleSubscriptionUpdated`.
  const existing = await CreditLedgerModel.findOne({ stripeEventId: event.id }).select('_id').lean();
  if (existing) {
    monetizationLog.info(`Duplicate invoice.paid event ${event.id}, skipping`);
    return;
  }

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
          'subscription.cancelAtPeriodEnd': isSubscriptionCancelling(subscription),
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
    monetizationLog.info(
      `Period reset: user=${user._id} plan=${effectivePlan} allowance=${user.credits.allowanceBalance}→${plan.monthlyAllowance} (${invoice.billing_reason})`,
    );

    // Mixpanel: only `subscription_cycle` is a true renewal — `subscription_update`
    // is a proration/upgrade and is already covered by `plan_upgraded`.
    if (invoice.billing_reason === 'subscription_cycle') {
      const amountCents = invoice.amount_paid ?? 0;
      const renewalCadence = mapPriceIdToPlan(newPriceId)?.cadence;
      analytics.track(user._id.toString(), 'subscription_renewed', {
        plan: effectivePlan,
        ...(renewalCadence && { cycle: renewalCadence }),
        amount_usd_cents: amountCents,
        amount_usd: Number((amountCents / 100).toFixed(2)),
        currency: invoice.currency ?? 'usd',
      });
    }
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    monetizationLog.info(`Duplicate invoice.paid event ${event.id}, skipping`);
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
  monetizationLog.warn(`Invoice payment failed: subscription=${subscriptionId} → past_due`);
  // No credit mutation here — user keeps current balance; Stripe's dunning
  // retries the payment over the next few days. A grace-period sweep job
  // (Phase 5) downgrades to free if dunning exhausts without success.

  // Resolve userId for the analytics fire — the updateOne above doesn't
  // return it. Skip the event if the subscription no longer maps to a
  // user (race: subscription deleted concurrently).
  const userRow = await UserModel.findOne({ 'subscription.stripeSubscriptionId': subscriptionId })
    .select('_id')
    .lean();
  if (!userRow) return;
  analytics.track(userRow._id.toString(), 'payment_failed', {
    reason: invoice.last_finalization_error?.message ?? 'unknown',
    retry_attempt: invoice.attempt_count ?? 0,
    amount_usd_cents: invoice.amount_due ?? 0,
  });
};

// ── Refunds & disputes ──────────────────────────────────────

/**
 * On a merchant-issued refund (full or partial), Stripe sends the money back
 * to the user's card. We mirror that by clawing back bonus credits so the
 * user can't keep both the money AND the credits from the refunded top-up.
 *
 * Only top-up payments carry the `flow=topup` + `userId` + `credits` metadata
 * we need. Subscription refunds (invoice refunds) are ignored here — those
 * clean up via `customer.subscription.deleted` if the sub is cancelled.
 *
 * Partial refunds are clawed back proportionally (ceil, so cent-scale
 * partials always clear ≥ 1 credit). Clamped at the user's current bonus
 * balance — if they've already spent part of the refunded top-up, we absorb
 * the difference rather than let their balance go negative. Matches the same
 * "bounded loss" principle the debit path uses.
 *
 * Idempotent via `stripeEventId` on the ledger row — duplicate webhook
 * deliveries insert once, subsequent retries hit E11000 and no-op.
 */
const handleChargeRefunded = async (event: Stripe.Event): Promise<void> => {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) return;

  const stripe = getStripe();
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const metadata = paymentIntent.metadata ?? {};
  if (metadata.flow !== 'topup') return;

  const userId = metadata.userId;
  const creditsGranted = Number(metadata.credits);
  if (!userId || !Number.isInteger(creditsGranted) || creditsGranted <= 0) {
    monetizationLog.warn(`charge.refunded for topup PI ${paymentIntentId} with invalid metadata, event ${event.id}`);
    return;
  }

  // `charge.refunds.data` is newest-first; the refund that triggered this
  // event is index 0. Fall back to `charge.amount_refunded` vs `charge.amount`
  // if for some reason the list is empty.
  const latestRefund = charge.refunds?.data?.[0];
  const refundAmount = latestRefund?.amount ?? charge.amount_refunded;
  const chargeAmount = charge.amount;
  if (!refundAmount || !chargeAmount) return;

  const clawbackCredits = Math.ceil((creditsGranted * refundAmount) / chargeAmount);
  if (clawbackCredits <= 0) return;

  await applyClawback({
    userId,
    stripeEventId: event.id,
    reason: 'refund_topup',
    clawbackCredits,
    notes: `Refund ($${(refundAmount / 100).toFixed(2)}) on top-up ${paymentIntentId}`,
    logLabel: `Refund: user=${userId} amount=$${(refundAmount / 100).toFixed(2)} of $${(chargeAmount / 100).toFixed(2)}`,
  });
};

/**
 * When Stripe opens a dispute, funds are pulled from our account immediately
 * (the user's bank already has the money back). Clawback credits pre-emptively
 * so the user isn't able to keep the credits while we're also down the cash.
 * If the dispute resolves in our favor, the funds are returned — a future
 * `charge.dispute.closed` handler could reverse the clawback, but for now
 * that's a manual-admin path (out of scope per plan).
 */
const handleChargeDisputeCreated = async (event: Stripe.Event): Promise<void> => {
  const dispute = event.data.object as Stripe.Dispute;
  const paymentIntentId =
    typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!paymentIntentId) return;

  const stripe = getStripe();
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const metadata = paymentIntent.metadata ?? {};
  if (metadata.flow !== 'topup') return;

  const userId = metadata.userId;
  const creditsGranted = Number(metadata.credits);
  if (!userId || !Number.isInteger(creditsGranted) || creditsGranted <= 0) return;

  // Disputes are typically for the full charge amount, but the Dispute object
  // does expose `amount` — scale proportionally just like refunds.
  const disputeAmount = dispute.amount;
  const chargeAmount = typeof dispute.charge === 'string' ? 0 : (dispute.charge?.amount ?? 0);
  const clawbackCredits =
    chargeAmount > 0 ? Math.ceil((creditsGranted * disputeAmount) / chargeAmount) : creditsGranted;
  if (clawbackCredits <= 0) return;

  await applyClawback({
    userId,
    stripeEventId: event.id,
    reason: 'dispute_clawback',
    clawbackCredits,
    notes: `Dispute opened on top-up ${paymentIntentId} ($${(disputeAmount / 100).toFixed(2)})`,
    logLabel: `Dispute opened: user=${userId} amount=$${(disputeAmount / 100).toFixed(2)} pi=${paymentIntentId}`,
  });
};

const applyClawback = async ({
  userId,
  stripeEventId,
  reason,
  clawbackCredits,
  notes,
  logLabel,
}: {
  userId: string;
  stripeEventId: string;
  reason: CreditLedgerReason;
  clawbackCredits: number;
  notes: string;
  logLabel: string;
}): Promise<void> => {
  // Ledger-first idempotency. Unlike the grant handlers (which $inc then
  // write ledger), clawbacks need to be rock-solid against webhook retries —
  // a double-debit on a retry is user-visible pain, while a double-ledger
  // lookup is cheap. Pre-check the unique stripeEventId and bail before the
  // `$inc` if this event already landed.
  const existing = await CreditLedgerModel.findOne({ stripeEventId }).select('_id').lean();
  if (existing) {
    monetizationLog.info(`${logLabel} — duplicate event, skipping`);
    return;
  }

  const user = await UserModel.findById(userId).select('credits').lean();
  if (!user) return;

  // Clamp at what's still in the bonus balance. Allowance is untouched —
  // top-ups land in bonus, and clawback should only pull from where the
  // money went in the first place.
  const actualClawback = Math.min(clawbackCredits, user.credits.bonusBalance);

  if (actualClawback > 0) {
    await UserModel.updateOne({ _id: userId }, { $inc: { 'credits.bonusBalance': -actualClawback } });
  }

  const bonusAfter = user.credits.bonusBalance - actualClawback;

  try {
    await writeLedger({
      userId,
      stripeEventId,
      reason,
      allowanceDelta: 0,
      bonusDelta: -actualClawback,
      balanceBefore: user.credits.allowanceBalance,
      balanceAfter: user.credits.allowanceBalance,
      bonusBefore: user.credits.bonusBalance,
      bonusAfter,
      notes:
        actualClawback < clawbackCredits
          ? `${notes} (intended −${clawbackCredits}, clamped to −${actualClawback})`
          : notes,
    });
    const clamped =
      actualClawback < clawbackCredits
        ? ` (clamped from ${clawbackCredits} — ${clawbackCredits - actualClawback} absorbed)`
        : '';
    const level = reason === 'dispute_clawback' ? 'warn' : 'info';
    monetizationLog[level](
      `${logLabel} → clawback=−${actualClawback} credits${clamped} bonus=${user.credits.bonusBalance}→${bonusAfter}`,
    );
  } catch (err) {
    // If two events with the same id arrive concurrently and both pass the
    // pre-check above, the second insert will E11000 here — the first
    // webhook already debited. Swallow; rare and bounded.
    if (!isDuplicateKeyError(err)) throw err;
    monetizationLog.info(`${logLabel} — duplicate event race, skipping`);
  }
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

type LedgerArgs = {
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
};

/**
 * Insert the ledger row only. Caller passes a `session` to enrol the insert
 * in an enclosing transaction (so a $inc + this insert commit/rollback as a
 * unit). Throws on E11000 — caller catches to detect the duplicate-event
 * race and abort their transaction cleanly.
 */
const insertLedgerRow = async (args: LedgerArgs, session?: ClientSession | null): Promise<void> => {
  await CreditLedgerModel.create(
    [
      {
        userId: args.userId,
        timestamp: new Date(),
        delta: args.allowanceDelta + args.bonusDelta,
        allowanceDelta: args.allowanceDelta,
        bonusDelta: args.bonusDelta,
        balanceBefore: args.balanceBefore,
        balanceAfter: args.balanceAfter,
        bonusBefore: args.bonusBefore,
        bonusAfter: args.bonusAfter,
        reason: args.reason,
        stripeEventId: args.stripeEventId,
        notes: args.notes,
      },
    ],
    session ? { session } : undefined,
  );
};

/**
 * Side-effect: announce the new balance to the user's socket room. Must run
 * AFTER the enclosing transaction commits — emitting before commit would
 * leak a "credits granted" UI signal even if the DB write rolls back.
 */
const emitLedgerSocket = (args: LedgerArgs): void => {
  emitCreditsUpdated({
    userId: args.userId,
    payload: {
      allowance: args.balanceAfter,
      bonus: args.bonusAfter,
      total: args.balanceAfter + args.bonusAfter,
      delta: args.allowanceDelta + args.bonusDelta,
      reason: args.reason,
    },
  });
};

const writeLedger = async (args: LedgerArgs): Promise<void> => {
  try {
    await insertLedgerRow(args);
    emitLedgerSocket(args);
  } catch (err) {
    if (isDuplicateKeyError(err)) return; // already processed
    captureError(err, {
      tags: { area: 'stripe.webhook.ledger' },
      extra: { stripeEventId: args.stripeEventId, reason: args.reason },
      fingerprint: ['stripe', 'ledger', String(args.reason)],
    });
    throw err;
  }
};
