import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { STRIPE_WEBHOOK_SECRET } from '@conf/env';
import { monetizationLog } from '@lib/loggers';
import { constructWebhookEvent } from '@services/stripeService';
import { handleStripeEvent, RetryableWebhookError } from '@services/stripeWebhookService';

/**
 * Stripe webhook entrypoint. This route must be mounted with `express.raw()`
 * BEFORE the global `express.json()` parser — signature verification runs
 * against the raw bytes and is rejected if the body has been JSON-decoded
 * in place.
 *
 * Response policy (revised):
 *   - Bad signature → 400 (Stripe doesn't retry; we don't want it to)
 *   - Handler succeeded → 200
 *   - Handler threw `RetryableWebhookError` (transient: DB outage, vendor
 *     error, etc.) → 5xx so Stripe retries us with exponential backoff
 *   - Handler threw any other error → 200 + Sentry capture. We ack to break
 *     the retry loop on *deterministic* failures (a malformed payload, a
 *     bug we shipped) — re-delivery won't help. Reconciliation cron picks
 *     up the drift. This is the deliberate trade-off described in the
 *     audit: deterministic bugs are reconciled, transient failures retry.
 *
 * The handler differentiates by throwing the right error class. Anything
 * not specifically classified as retryable defaults to ack-and-log.
 */
export const stripeWebhookController = async (req: Request, res: Response): Promise<void> => {
  if (!STRIPE_WEBHOOK_SECRET) {
    monetizationLog.error('Webhook fired but STRIPE_WEBHOOK_SECRET is not configured');
    res.status(500).send('Webhook not configured');
    return;
  }

  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    res.status(400).send('Missing stripe-signature header');
    return;
  }

  let event;
  try {
    event = constructWebhookEvent({
      payload: req.body as Buffer,
      signature,
      secret: STRIPE_WEBHOOK_SECRET,
    });
  } catch (err) {
    monetizationLog.warn(`Webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(400).send('Signature verification failed');
    return;
  }

  try {
    await handleStripeEvent(event);
    res.status(200).json({ received: true });
  } catch (err) {
    const isRetryable = err instanceof RetryableWebhookError;
    monetizationLog.error(
      `Webhook handler threw for ${event.type} (${event.id}) retryable=${isRetryable}: ${err instanceof Error ? err.message : String(err)}`,
    );
    Sentry.captureException(err, {
      tags: { area: 'stripe.webhook', eventType: event.type, retryable: String(isRetryable) },
      extra: { eventId: event.id },
    });

    if (isRetryable) {
      // 503 → Stripe retries with exponential backoff up to ~3 days.
      res.status(503).json({ received: false, retry: true });
      return;
    }

    // Deterministic / unclassified errors: ack to stop retry storm.
    // Reconciliation cron is responsible for catching any drift.
    res.status(200).json({ received: true, handlerError: true });
  }
};
