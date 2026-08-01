import asyncHandler from 'express-async-handler';
import type { Request } from 'express';
import { FRONTEND_URL } from '@conf/env';
import MarketingContactModel from '@models/MarketingContactModel';
import { verifyMarketingUnsubToken } from '@lib/marketingUnsubToken';
import { syncSuppression } from '@services/mailjetContactService';
import { integrationLog } from '@lib/loggers';
import { bgError } from '@lib/bg';

// The unsubscribe surface WE own (PLAN Phase 3, A12 / F1 / F16).
//
// Both handlers are **public**: the recipient is a mail client or a
// logged-out browser, and they are registered in `authRoutes` without a
// `protect` argument (that router gates per route — there is no
// `router.use(protect)`). Authorisation is the per-contact HMAC token in
// the query string and nothing else.
//
// Confirmation page for the human-visible path.
const CONFIRMATION_URL = `${FRONTEND_URL.replace(/\/$/, '')}/unsubscribed`;

/**
 * Apply the opt-out named by the token.
 *
 * **Deliberately silent about outcomes** (security.md §5.5): an unknown,
 * expired-looking, tampered or absent token produces exactly the same
 * observable result as a successful one. Do NOT "improve" this into a 404
 * on unknown — the route would become an oracle telling any caller whether
 * a given contact id (and therefore a given subscriber) exists.
 *
 * Idempotent: a second click on the same link re-pushes the suppression to
 * Mailjet (self-healing if the first push failed) but does not move
 * `optedOutAt`, which records when the user actually asked.
 */
const applyUnsubscribe = async (req: Request): Promise<void> => {
  // The token rides in the query string, never the body: an RFC 8058
  // one-click POST arrives as `application/x-www-form-urlencoded`, which
  // this API mounts no parser for, so `req.body` is not readable here.
  const rawToken = req.query?.token ?? (req.body as { token?: unknown } | undefined)?.token;

  const contactId = verifyMarketingUnsubToken(rawToken);
  if (!contactId) {
    integrationLog.info('marketing:unsubscribe token-rejected');
    return;
  }

  const contact = await MarketingContactModel.findById(contactId).select('email optedOut').lean();
  if (!contact) {
    integrationLog.info('marketing:unsubscribe contact-not-found');
    return;
  }

  if (!contact.optedOut) {
    await MarketingContactModel.updateOne(
      { _id: contactId },
      { $set: { optedOut: true, optedOutAt: new Date() } },
    );
    integrationLog.info(`marketing:unsubscribe ok contactId=${contactId}`);
  }

  // Fail-soft by design — our ledger already decides the audience, so a
  // Mailjet outage must not turn an opt-out into an error the user has to
  // retry. `syncSuppression` swallows its own vendor errors; the try/catch
  // is the boundary guarantee, so this handler cannot start throwing
  // because a dependency's internal contract changed.
  try {
    await syncSuppression(contact.email);
  } catch (err) {
    bgError('mailjet.syncSuppressionOnUnsubscribe')(err);
  }
};

/**
 * @swagger
 * /api/auth/marketing/unsubscribe:
 *   post:
 *     summary: One-click unsubscribe from promotional email (RFC 8058)
 *     description: |
 *       Public endpoint — no session. Authorised solely by the per-contact
 *       HMAC token in the `token` query parameter, which is the target of
 *       the `List-Unsubscribe` header on every promotional message.
 *       Idempotent, and deliberately uniform: an unknown or tampered token
 *       returns the same 200 as a valid one so the endpoint cannot be used
 *       to test whether an address is a subscriber.
 *     tags:
 *       - Auth
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: Per-contact HMAC unsubscribe token.
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 *                   required: [unsubscribed]
 *                   properties:
 *                     unsubscribed:
 *                       type: boolean
 */
export const unsubscribeMarketingController = asyncHandler(async (req, res) => {
  await applyUnsubscribe(req);
  res.status(200).json({ data: { unsubscribed: true } });
});

/**
 * @swagger
 * /api/auth/marketing/unsubscribe:
 *   get:
 *     summary: Human-visible unsubscribe confirmation
 *     description: |
 *       Public endpoint — no session. Applies the opt-out and redirects to
 *       the `/unsubscribed` confirmation page. Redirects to the same page
 *       whatever the token turns out to be, for the same
 *       no-existence-oracle reason as the POST variant.
 *
 *       Note on GET-mutates-state: a link scanner that prefetches the URL
 *       will unsubscribe the recipient. That is the safe direction to be
 *       wrong in (over-suppression, never under), and the profile toggle is
 *       an always-available re-opt-in — whereas a confirmation page that
 *       required a second click would lose opt-outs from anyone who did not
 *       take it.
 *     tags:
 *       - Auth
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirect to the public confirmation page.
 */
export const unsubscribeMarketingConfirmController = asyncHandler(async (req, res) => {
  await applyUnsubscribe(req);
  res.redirect(302, CONFIRMATION_URL);
});
