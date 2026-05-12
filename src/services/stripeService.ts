// tsconfig `paths` overrides the "stripe" module to resolve to the ESM
// types (esm/stripe.esm.node.d.ts) which exports the class + namespace as
// a single symbol, so `new Stripe()`, `Stripe.Event`, `Stripe.Checkout.Session`
// all work. The CJS entry's `export = StripeConstructor` pattern hides the
// namespace under NodeNext and breaks namespace access without this hint.
import Stripe from 'stripe';
import {
  FRONTEND_URL,
  STRIPE_PRICE_ID_PRO_ANNUAL,
  STRIPE_PRICE_ID_PRO_MONTHLY,
  STRIPE_PRICE_ID_STARTER_ANNUAL,
  STRIPE_PRICE_ID_STARTER_MONTHLY,
  STRIPE_PRICE_ID_STUDIO_ANNUAL,
  STRIPE_PRICE_ID_STUDIO_MONTHLY,
  STRIPE_SECRET_KEY,
  STRIPE_TAX_ENABLED,
} from '@conf/env';
import UserModel from '@models/UserModel';
import {
  PlanKey,
  TOPUP_CREDITS_PER_USD,
  TOPUP_MAX_USD,
  TOPUP_MIN_USD,
} from '@lib/creditPricing';
import { monetizationLog } from '@lib/loggers';

// ── Client singleton ──────────────────────────────────────

let cachedClient: Stripe | null = null;

/**
 * Lazy-initialized Stripe client. Throws clearly at call-time if the secret
 * key is missing — the server still boots without Stripe so Phase 1/2
 * features (lite-mode, metering behind the flag) can land independently.
 */
export const getStripe = (): Stripe => {
  if (cachedClient) return cachedClient;
  if (!STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured — billing features are disabled.');
  }
  // No explicit apiVersion — we inherit the SDK's pinned default so our
  // types + Stripe's wire format stay in lockstep. Bumping Stripe the npm
  // package is a deliberate migration, not a silent drift.
  cachedClient = new Stripe(STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
  });
  return cachedClient;
};

// ── Price-ID → plan mapping ──────────────────────────────

export type BillingCadence = 'monthly' | 'annual';

/**
 * Resolve a Stripe price ID back to our internal plan + cadence. Returns
 * null for unknown IDs (unrecognized webhook events, stale price IDs, etc.)
 * — callers must treat null as "not a subscription we manage" and skip
 * state changes rather than crashing.
 *
 * Pure — safe to call without a configured Stripe key.
 */
export const mapPriceIdToPlan = (priceId: string | null | undefined): {
  plan: PlanKey;
  cadence: BillingCadence;
} | null => {
  if (!priceId) return null;
  if (priceId === STRIPE_PRICE_ID_STARTER_MONTHLY) return { plan: 'starter', cadence: 'monthly' };
  if (priceId === STRIPE_PRICE_ID_STARTER_ANNUAL) return { plan: 'starter', cadence: 'annual' };
  if (priceId === STRIPE_PRICE_ID_PRO_MONTHLY) return { plan: 'pro', cadence: 'monthly' };
  if (priceId === STRIPE_PRICE_ID_PRO_ANNUAL) return { plan: 'pro', cadence: 'annual' };
  if (priceId === STRIPE_PRICE_ID_STUDIO_MONTHLY) return { plan: 'studio', cadence: 'monthly' };
  if (priceId === STRIPE_PRICE_ID_STUDIO_ANNUAL) return { plan: 'studio', cadence: 'annual' };
  return null;
};

export const resolveSubscriptionPriceId = ({
  plan,
  cadence,
}: {
  plan: PlanKey;
  cadence: BillingCadence;
}): string | null => {
  if (plan === 'starter' && cadence === 'monthly') return STRIPE_PRICE_ID_STARTER_MONTHLY ?? null;
  if (plan === 'starter' && cadence === 'annual') return STRIPE_PRICE_ID_STARTER_ANNUAL ?? null;
  if (plan === 'pro' && cadence === 'monthly') return STRIPE_PRICE_ID_PRO_MONTHLY ?? null;
  if (plan === 'pro' && cadence === 'annual') return STRIPE_PRICE_ID_PRO_ANNUAL ?? null;
  if (plan === 'studio' && cadence === 'monthly') return STRIPE_PRICE_ID_STUDIO_MONTHLY ?? null;
  if (plan === 'studio' && cadence === 'annual') return STRIPE_PRICE_ID_STUDIO_ANNUAL ?? null;
  return null;
};

// ── Customer lifecycle ──────────────────────────────────────

/**
 * Get the user's Stripe Customer id, creating one lazily if absent. We don't
 * create customers on signup — too many free users would never convert. The
 * first billing action (checkout or portal) calls this.
 *
 * Uses a findOneAndUpdate conditional-on-null-customer-id so two concurrent
 * requests that both see a missing id don't create duplicate Stripe
 * customers; the loser reads the winner's id and throws its Stripe customer
 * away (Stripe-side orphan; we log but don't retry — orphans are harmless
 * unused records).
 */
export const ensureStripeCustomer = async ({ userId }: { userId: string }): Promise<string> => {
  const user = await UserModel.findById(userId).select('email name subscription.stripeCustomerId').lean();
  if (!user) throw new Error('User not found');
  if (user.subscription?.stripeCustomerId) return user.subscription.stripeCustomerId;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: user.email,
    ...(user.name && { name: user.name }),
    metadata: { userId },
  });

  const claim = await UserModel.findOneAndUpdate(
    { _id: userId, 'subscription.stripeCustomerId': { $in: [null, undefined] } },
    { $set: { 'subscription.stripeCustomerId': customer.id } },
    { new: true, projection: 'subscription.stripeCustomerId' },
  );

  if (!claim) {
    // Lost the race: read the winner's id. The orphaned customer we just
    // created will sit in Stripe unused — acceptable since customers are
    // free to create.
    const winner = await UserModel.findById(userId).select('subscription.stripeCustomerId').lean();
    monetizationLog.warn(`Race creating Stripe customer for user=${userId}, orphaned ${customer.id}`);
    return winner?.subscription?.stripeCustomerId ?? customer.id;
  }

  monetizationLog.info(`Stripe customer created: user=${userId} customer=${customer.id}`);
  return customer.id;
};

// ── Checkout sessions ──────────────────────────────────────

// Land every successful Stripe Checkout directly on the Billing tab under
// Profile — the single canonical place for billing state. A `checkout`
// query param marks the flow kind so the client can show a short welcome
// toast ("Subscription active" / "Bonus credits added") and then strip
// the param from the URL.
const buildSuccessUrl = ({ kind }: { kind: 'subscription' | 'topup' }): string =>
  `${FRONTEND_URL}/profile?tab=billing&checkout=${kind}`;
const buildCancelUrl = (): string => `${FRONTEND_URL}/pricing`;

/**
 * Subscription Checkout. On completion the webhook `checkout.session.completed`
 * (mode=subscription) activates the user's plan. `metadata` carries `userId`
 * and `planKey` so the webhook can join back to our User without a second
 * Stripe API call.
 */
// Stripe subscription statuses that should prevent a second concurrent
// subscription. Anything in these states means the customer has an existing
// commitment Stripe is still tracking — they should manage it via Portal,
// not stack a second one. Excluded: `canceled` and `incomplete_expired`,
// which are terminal and safe to subscribe over.
const BLOCKING_SUB_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
  'paused',
]);

export const createSubscriptionCheckout = async ({
  userId,
  plan,
  cadence,
  replaceCurrentSubscription = false,
}: {
  userId: string;
  plan: PlanKey;
  cadence: BillingCadence;
  /**
   * When true, skip the duplicate-subscription guard and stamp the user's
   * existing subscription id into Checkout metadata. The webhook will cancel
   * that old subscription immediately after the new one activates — giving
   * users an explicit "cancel-and-replace" plan switch instead of Stripe
   * Portal's silent in-place proration.
   */
  replaceCurrentSubscription?: boolean;
}): Promise<Stripe.Checkout.Session> => {
  const priceId = resolveSubscriptionPriceId({ plan, cadence });
  if (!priceId) {
    throw Object.assign(new Error(`No Stripe price configured for ${plan}/${cadence}`), { statusCode: 400 });
  }

  const stripe = getStripe();
  const customer = await ensureStripeCustomer({ userId });

  // Race-safe duplicate-subscription check. Asks Stripe directly (not our
  // DB) so we catch the case where the user already subscribed but our
  // webhook hasn't landed yet.
  // Limit 100 covers >99.9% of customers; pagination is unnecessary here.
  const existing = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
  const blocker = existing.data.find((s) => BLOCKING_SUB_STATUSES.has(s.status));

  let replacingSubscriptionId: string | undefined;
  if (blocker) {
    if (!replaceCurrentSubscription) {
      // Accidental double-checkout: reject.
      throw Object.assign(
        new Error('You already have an active subscription. Use the billing portal to change plans.'),
        {
          statusCode: 409,
          errorCode: 'SUBSCRIPTION_ALREADY_EXISTS',
          meta: { existingSubscriptionId: blocker.id, status: blocker.status },
        },
      );
    }
    // Explicit replacement: old sub id flows through Checkout metadata so
    // the webhook can cancel it once the new one is paid for.
    replacingSubscriptionId = blocker.id;
  }

  const session = await stripe.checkout.sessions.create({
    customer,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: buildSuccessUrl({ kind: 'subscription' }),
    cancel_url: buildCancelUrl(),
    allow_promotion_codes: true,
    // Stripe Tax computes VAT automatically based on the customer's address.
    // Required for EU consumer sales (OSS rules from euro one). Toggled by
    // STRIPE_TAX_ENABLED env so dev / testing accounts without Stripe Tax
    // configured don't 400 every checkout.
    automatic_tax: { enabled: STRIPE_TAX_ENABLED },
    // Address collection is required when tax is on (Stripe needs the
    // country to pick the right VAT rate) and is harmless otherwise.
    billing_address_collection: STRIPE_TAX_ENABLED ? 'required' : 'auto',
    // Persist the collected address on the Customer record so subsequent
    // top-ups / portal sessions inherit it. `tax_id` lets B2B customers
    // enter a VAT id that Stripe Tax then validates and exempts.
    customer_update: STRIPE_TAX_ENABLED ? { address: 'auto', name: 'auto' } : undefined,
    tax_id_collection: STRIPE_TAX_ENABLED ? { enabled: true } : undefined,
    metadata: {
      userId,
      planKey: plan,
      cadence,
      ...(replacingSubscriptionId ? { replacingSubscriptionId } : {}),
    },
    subscription_data: {
      metadata: {
        userId,
        planKey: plan,
        cadence,
        ...(replacingSubscriptionId ? { replacingSubscriptionId } : {}),
      },
    },
  });
  monetizationLog.info(
    `Subscription checkout started: user=${userId} plan=${plan}/${cadence}${replacingSubscriptionId ? ` replacing=${replacingSubscriptionId}` : ''}`,
  );
  return session;
};

/**
 * Top-up (one-time payment) Checkout for a variable whole-dollar amount. The
 * user picks any integer USD between TOPUP_MIN_USD and TOPUP_MAX_USD and
 * receives `amountUsd × TOPUP_CREDITS_PER_USD` credits added to their bonus
 * balance on webhook receipt (never expire, consumed after allowance).
 *
 * Stripe-side: uses inline `price_data` instead of a pre-created Price
 * object, so the amount can be arbitrary per session. Credit count is
 * stamped into BOTH the session metadata AND the PaymentIntent metadata —
 * the session metadata is read by `checkout.session.completed` (granting
 * credits) and the PaymentIntent metadata is what `charge.refunded` sees
 * when we eventually add refund clawback.
 *
 * Input validation happens both here (defensive) AND at the route layer
 * via Zod — two belts for the same trousers because a wrong amount here
 * becomes a wrong Stripe charge, which is very hard to unwind.
 */
export const createTopupCheckout = async ({
  userId,
  amountUsd,
}: {
  userId: string;
  amountUsd: number;
}): Promise<Stripe.Checkout.Session> => {
  if (!Number.isInteger(amountUsd)) {
    throw Object.assign(new Error('Top-up amount must be a whole number of USD'), { statusCode: 400 });
  }
  if (amountUsd < TOPUP_MIN_USD || amountUsd > TOPUP_MAX_USD) {
    throw Object.assign(
      new Error(`Top-up amount must be between $${TOPUP_MIN_USD} and $${TOPUP_MAX_USD}`),
      { statusCode: 400 },
    );
  }

  const credits = amountUsd * TOPUP_CREDITS_PER_USD;
  const unitAmountCents = amountUsd * 100;

  const stripe = getStripe();
  const customer = await ensureStripeCustomer({ userId });

  const session = await stripe.checkout.sessions.create({
    customer,
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Allowance top-up',
            // User-visible on the Stripe Checkout page. Phrased around dollars
            // + behavior (never expires, spent before subscription allowance);
            // never mentions the internal "credits" unit.
            description: `$${amountUsd} of pay-as-you-go allowance — never expires, used first when generating courses and lessons.`,
          },
          unit_amount: unitAmountCents,
        },
        quantity: 1,
      },
    ],
    success_url: buildSuccessUrl({ kind: 'topup' }),
    // Canceled top-up sends user back to where they probably clicked from —
    // the Billing tab under Profile.
    cancel_url: `${FRONTEND_URL}/profile?tab=billing`,
    allow_promotion_codes: true,
    // Same Stripe Tax stance as subscription checkout. See note there.
    automatic_tax: { enabled: STRIPE_TAX_ENABLED },
    billing_address_collection: STRIPE_TAX_ENABLED ? 'required' : 'auto',
    customer_update: STRIPE_TAX_ENABLED ? { address: 'auto', name: 'auto' } : undefined,
    tax_id_collection: STRIPE_TAX_ENABLED ? { enabled: true } : undefined,
    // Two metadata scopes. Session metadata is read by
    // `checkout.session.completed`; PaymentIntent metadata follows the
    // charge through any future refund so we can claw back credits
    // without a session round-trip.
    metadata: { userId, flow: 'topup', credits: String(credits), amountUsd: String(amountUsd) },
    payment_intent_data: {
      metadata: { userId, flow: 'topup', credits: String(credits), amountUsd: String(amountUsd) },
    },
  });
  monetizationLog.info(
    `Top-up checkout started: user=${userId} credits=${credits} amount=$${amountUsd}`,
  );
  return session;
};

// ── Customer Portal ──────────────────────────────────────

/**
 * Create a Stripe Customer Portal session for self-serve subscription
 * management (plan change / cancel / payment method / invoice history).
 * Portal UX + capabilities are configured in Stripe dashboard, not here —
 * we just mint a short-lived URL and redirect.
 */
export const createPortalSession = async ({ userId }: { userId: string }): Promise<Stripe.BillingPortal.Session> => {
  const stripe = getStripe();
  const customer = await ensureStripeCustomer({ userId });
  return stripe.billingPortal.sessions.create({
    customer,
    // Land the user back on the Profile > Billing tab (single canonical
    // location for billing state — the standalone `/billing` page was
    // removed in favor of `/profile?tab=billing`).
    return_url: `${FRONTEND_URL}/profile?tab=billing`,
  });
};

// ── Scheduled downgrade / cancellation (no-charge, at-period-end) ────

/**
 * Plan-rank lookup for upgrade/downgrade direction checks. `free` is rank 0,
 * paid tiers ascend. Duplicates the client-side `PLAN_RANK` deliberately so
 * the server doesn't trust client assertions about direction.
 */
const PLAN_RANK: Record<PlanKey, number> = { free: 0, starter: 1, pro: 2, studio: 3 };

/**
 * Schedule a paid→lower-paid downgrade. No charge now: the current period
 * stays paid at the higher-tier price (already invoiced), and Stripe bills
 * at the new lower price on the next cycle.
 *
 * Mechanics:
 *   1. Stripe API: update the subscription's item to the new price with
 *      `proration_behavior: 'none'` — this flips the active price record
 *      but doesn't generate a proration invoice.
 *   2. Stripe fires `customer.subscription.updated` → our webhook detects
 *      direction='downgrade' (old plan in DB vs new price from event) and
 *      stamps `pendingPlan` on the User while keeping `plan` unchanged.
 *   3. At period end, `invoice.paid` fires at the new price → our handler
 *      applies `pendingPlan` and resets credits to the new (smaller)
 *      allowance.
 *
 * Edge-case guards (rejected at schedule time):
 *   - No active paid subscription
 *   - Target is not strictly lower than current plan
 *   - Target === current plan (no-op)
 *   - Subscription already scheduled to cancel (two terminal actions can't
 *     be stacked; user must un-cancel first via Portal)
 */
export const scheduleSubscriptionDowngrade = async ({
  userId,
  plan,
  cadence,
}: {
  userId: string;
  plan: PlanKey;
  cadence: BillingCadence;
}): Promise<{ periodEnd: Date | null; scheduledPlan: PlanKey }> => {
  if (plan === 'free') {
    throw Object.assign(new Error('Use the cancel endpoint to downgrade to Free'), { statusCode: 400 });
  }

  const user = await UserModel
    .findById(userId)
    .select('subscription')
    .lean();
  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }

  const subId = user.subscription?.stripeSubscriptionId;
  const currentPlan = user.subscription?.plan ?? 'free';
  if (!subId || currentPlan === 'free') {
    throw Object.assign(new Error('No active subscription to downgrade'), { statusCode: 400 });
  }

  if (currentPlan === plan) {
    throw Object.assign(new Error('You are already on this plan'), { statusCode: 409 });
  }
  if (PLAN_RANK[plan] >= PLAN_RANK[currentPlan]) {
    throw Object.assign(new Error('Target plan is not lower than current plan — use upgrade flow'), { statusCode: 400 });
  }

  if (user.subscription?.cancelAtPeriodEnd) {
    throw Object.assign(
      new Error('Your subscription is already scheduled to cancel — reactivate from the billing portal first.'),
      { statusCode: 409 },
    );
  }

  const newPriceId = resolveSubscriptionPriceId({ plan, cadence });
  if (!newPriceId) {
    throw Object.assign(new Error(`No Stripe price configured for ${plan}/${cadence}`), { statusCode: 400 });
  }

  const stripe = getStripe();
  const currentSub = await stripe.subscriptions.retrieve(subId);
  const currentItemId = currentSub.items.data[0]?.id;
  if (!currentItemId) {
    throw Object.assign(new Error('Subscription has no items — cannot downgrade'), { statusCode: 500 });
  }

  // Stripe API version 2025-03-31 moved current_period_* onto items, so we
  // read it from the first item. Captured BEFORE the update so the return
  // value reflects the unchanged cycle boundary (the update doesn't shift
  // the period anyway).
  const periodEndSeconds = currentSub.items.data[0]?.current_period_end;
  const periodEnd = typeof periodEndSeconds === 'number' ? new Date(periodEndSeconds * 1000) : null;

  await stripe.subscriptions.update(subId, {
    items: [{ id: currentItemId, price: newPriceId }],
    proration_behavior: 'none',
  });

  monetizationLog.info(
    `Downgrade requested: user=${userId} ${currentPlan}→${plan}/${cadence} applies at ${periodEnd?.toISOString() ?? '(unknown)'}`,
  );
  return { periodEnd, scheduledPlan: plan };
};

/**
 * Schedule subscription cancellation at period end. No immediate charge or
 * refund. User keeps full paid-tier access until the cycle completes, then
 * drops to Free via the `customer.subscription.deleted` webhook.
 *
 * Edge-case guards:
 *   - No active paid subscription
 *   - Subscription already scheduled to cancel
 */
export const scheduleSubscriptionCancellation = async ({
  userId,
}: {
  userId: string;
}): Promise<{ periodEnd: Date | null }> => {
  const user = await UserModel
    .findById(userId)
    .select('subscription')
    .lean();
  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }

  const subId = user.subscription?.stripeSubscriptionId;
  const currentPlan = user.subscription?.plan ?? 'free';
  if (!subId || currentPlan === 'free') {
    throw Object.assign(new Error('No active subscription to cancel'), { statusCode: 400 });
  }

  if (user.subscription?.cancelAtPeriodEnd) {
    throw Object.assign(new Error('Your subscription is already scheduled to cancel'), { statusCode: 409 });
  }

  const stripe = getStripe();
  const updated = await stripe.subscriptions.update(subId, {
    cancel_at_period_end: true,
  });

  const periodEndSeconds = updated.items.data[0]?.current_period_end;
  const periodEnd = typeof periodEndSeconds === 'number' ? new Date(periodEndSeconds * 1000) : null;

  monetizationLog.info(
    `Cancellation requested: user=${userId} subscription=${subId} ends=${periodEnd?.toISOString() ?? '(unknown)'}`,
  );
  return { periodEnd };
};

// ── Account deletion helpers ──────────────────────────────

/**
 * Cancel an active Stripe subscription immediately. Called from the
 * account-deletion flow so a user who deletes their account isn't billed
 * next period. Swallows most errors (already canceled, not found) since
 * the primary goal — ensuring no future charges — holds regardless.
 *
 * No refund: we mirror Stripe's default behavior and our own ToS (no
 * partial-month refunds). Handle refunds separately via admin tooling.
 */
export const cancelStripeSubscriptionSafely = async ({
  subscriptionId,
}: {
  subscriptionId: string;
}): Promise<void> => {
  try {
    const stripe = getStripe();
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (err) {
    // `resource_missing` means the subscription is already gone (canceled
    // through Portal, or never existed). Non-fatal — the user is being
    // deleted anyway; we just wanted to stop recurring charges.
    const code = (err as { code?: string })?.code;
    if (code === 'resource_missing') return;
    throw err;
  }
};

/**
 * Cancel EVERY non-terminal subscription on a Stripe customer. Stronger than
 * `cancelStripeSubscriptionSafely` because our DB only tracks one
 * subscription id per user — if drift, manual creation, or the historical
 * duplicate-checkout bug left stragglers, cancelling just the tracked one
 * leaves the others billing. Used by account deletion so deletion really
 * means deletion.
 *
 * Returns the number of subscriptions actually canceled. Errors on
 * individual cancels are swallowed (logged via the caller's bgError) so
 * one stuck subscription doesn't block the rest. List size capped at 100,
 * which is far more than realistic.
 */
export const cancelAllSubscriptionsForCustomer = async ({
  customerId,
}: {
  customerId: string;
}): Promise<number> => {
  const stripe = getStripe();
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  // Skip already-terminal statuses to avoid wasted API calls and 'resource_missing' noise.
  const terminal = new Set(['canceled', 'incomplete_expired']);
  const cancellable = subs.data.filter((s) => !terminal.has(s.status));
  let canceled = 0;
  for (const s of cancellable) {
    try {
      await stripe.subscriptions.cancel(s.id);
      canceled += 1;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'resource_missing') continue;
      monetizationLog.warn(
        `Failed to cancel ${s.id} during account deletion: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  monetizationLog.info(
    `Cancelled ${canceled}/${cancellable.length} subscription(s) on customer ${customerId} during account deletion`,
  );
  return canceled;
};

// ── Webhook signature verification ──────────────────────────

export const constructWebhookEvent = ({
  payload,
  signature,
  secret,
}: {
  payload: Buffer | string;
  signature: string;
  secret: string;
}): Stripe.Event => {
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(payload, signature, secret);
};
