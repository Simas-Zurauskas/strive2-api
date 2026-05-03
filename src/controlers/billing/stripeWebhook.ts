import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { STRIPE_WEBHOOK_SECRET } from '@conf/env';
import { monetizationLog } from '@lib/loggers';
import { constructWebhookEvent } from '@services/stripeService';
import { handleStripeEvent } from '@services/stripeWebhookService';

/**
 * Stripe webhook entrypoint. This route must be mounted with `express.raw()`
 * BEFORE the global `express.json()` parser — signature verification runs
 * against the raw bytes and is rejected if the body has been JSON-decoded
 * in place.
 *
 * Responds 200 as soon as the signature verifies. Business logic runs after
 * (or concurrently with) the response: Stripe retries on any non-2xx or
 * timeout (>30s), so we acknowledge fast and let internal errors surface
 * via Sentry without triggering Stripe's retry storm.
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
    // Handler errors shouldn't trigger infinite Stripe retries. Log + ack.
    // Business reconciliation (if any rows drifted) falls to the Phase 5
    // nightly cron, not to Stripe's retry loop.
    monetizationLog.error(
      `Webhook handler threw for ${event.type} (${event.id}): ${err instanceof Error ? err.message : String(err)}`,
    );
    Sentry.captureException(err, {
      tags: { area: 'stripe.webhook', eventType: event.type },
      extra: { eventId: event.id },
    });
    res.status(200).json({ received: true, handlerError: true });
  }
};
