import { z } from 'zod';
import { PLAN_KEYS, TOPUP_MAX_USD, TOPUP_MIN_USD } from '@lib/creditPricing';

// Subscription checkout: Free is not a paid plan, so we reject it at the schema
// layer — trying to "checkout" into Free would create a $0 Stripe session that
// then needs special handling downstream. Always reject.
export const checkoutSchema = z.object({
  plan: z.enum(PLAN_KEYS.filter((k) => k !== 'free') as ['starter', 'pro', 'studio']),
  cadence: z.enum(['monthly', 'annual']),
  /**
   * Set true when the caller already has an active paid subscription and is
   * intentionally replacing it. Bypasses the server-side duplicate guard and
   * stamps the old subscription id into Checkout metadata so the webhook
   * cancels it immediately after the new one activates.
   */
  replaceCurrentSubscription: z.boolean().optional().default(false),
});

// Variable-amount top-up: user picks any whole-dollar USD amount in
// [TOPUP_MIN_USD, TOPUP_MAX_USD]. Zod's coerce handles JSON numbers that
// arrive as strings (though the client sends numbers). Integer + range
// validation is duplicated in `createTopupCheckout` as a defense-in-depth
// guard; ignore the apparent redundancy — a wrong Stripe charge is very
// painful to unwind.
export const topupSchema = z.object({
  amountUsd: z.coerce
    .number()
    .int('Amount must be a whole number of US dollars')
    .min(TOPUP_MIN_USD, `Minimum top-up is $${TOPUP_MIN_USD}`)
    .max(TOPUP_MAX_USD, `Maximum top-up is $${TOPUP_MAX_USD}`),
});

// Downgrade targets 'starter' and 'pro' only — downgrading to Free means
// cancellation and goes through the dedicated /cancel endpoint. Studio can
// never be a downgrade target. Cadence mirrors the existing subscription.
export const downgradeSchema = z.object({
  plan: z.enum(['starter', 'pro']),
  cadence: z.enum(['monthly', 'annual']),
});

export const ledgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Cursor-based pagination using the ledger's `_id`. Opaque to the client —
  // it passes back whatever last row's `_id` was in the previous page.
  before: z.string().optional(),
});
