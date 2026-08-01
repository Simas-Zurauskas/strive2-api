import Mailjet from 'node-mailjet';
import {
  MAILJET_API_KEY,
  MAILJET_API_SECRET,
  SENDER_EMAIL_ACCOUNT,
  SENDER_EMAIL_PROMOTIONAL,
} from '@conf/env';
import { integrationLog } from '@lib/loggers';
import { captureError } from '@lib/errorReporter';
import {
  buildVerificationEmail,
  buildPasswordResetEmail,
  buildSecurityActionCodeEmail,
  buildDocumentsFeatureEmail,
  type EmailPayload,
  type SecurityActionKind,
} from '@lib/email/templates';

// Sender identities now live in `@conf/env` so the promotional stream can be
// moved to its own marketing subdomain without a deploy (PLAN A7). Re-exported
// here because every existing caller imports them from this module.
//
//   - Transactional (`SENDER_EMAIL_ACCOUNT`) — verification, password reset,
//     security codes. Anything users implicitly opted into by performing an
//     account action.
//   - Promotional (`SENDER_EMAIL_PROMOTIONAL`) — campaigns, anything that
//     carries an opt-out. Kept separate so spam complaints and soft bounces
//     on the marketing stream don't drag down the deliverability of
//     password-reset / verification mail.
//
// Mailjet prerequisites for the promotional address (operator, not code):
//   1. it is a verified sender in Mailjet → Senders & Domains;
//   2. SPF + DKIM DNS records cover it — for a dedicated marketing
//      subdomain that is a fresh pair of records, not the apex domain's;
//   3. optionally a sub-account / separate API key so marketing rate limits
//      cannot throttle transactional throughput.
export { SENDER_EMAIL_ACCOUNT, SENDER_EMAIL_PROMOTIONAL };

const mailjet = new Mailjet({
  apiKey: MAILJET_API_KEY,
  apiSecret: MAILJET_API_SECRET,
});

// ── Transport ────────────────────────────────────────────
//
// Single low-level send. Templates live in `lib/email/templates.ts` and
// produce `{ subject, html, text }` — this file just wraps Mailjet's API
// and the fire-and-forget retry harness.

const send = async (params: {
  to: string;
  payload: EmailPayload;
  from?: string;
  // Enables Mailjet's template language inside the message body —
  // required for `[[UNSUB_LINK_EN]]` (and any other `[[…]]` variables) to
  // be substituted server-side. Off by default so transactional templates
  // don't pay the parse cost / surface a render error if a stray bracket
  // pair sneaks into copy.
  templateLanguage?: boolean;
  // Extra SMTP headers. Used for RFC 8058 `List-Unsubscribe` +
  // `List-Unsubscribe-Post` on promotional mail, which is what turns the
  // mail client's own "unsubscribe" affordance into a one-click POST at our
  // route instead of a spam report.
  headers?: Record<string, string>;
  // PLAN A10 / F6. Mailjet's account default decides tracking when these are
  // unset, so "we don't use tracking pixels" was previously a dashboard
  // setting nobody could see from the code. Set explicitly per send, and
  // asserted in `emailService.test.ts`.
  disableTracking?: boolean;
}): Promise<void> => {
  const fromEmail = params.from ?? SENDER_EMAIL_ACCOUNT;
  await mailjet.post('send', { version: 'v3.1' }).request({
    Messages: [
      {
        From: { Email: fromEmail, Name: 'Strive' },
        To: [{ Email: params.to }],
        Subject: params.payload.subject,
        HTMLPart: params.payload.html,
        TextPart: params.payload.text,
        ...(params.templateLanguage ? { TemplateLanguage: true } : {}),
        ...(params.headers ? { Headers: params.headers } : {}),
        ...(params.disableTracking
          ? { TrackOpens: 'disabled', TrackClicks: 'disabled' }
          : {}),
      },
    ],
  });
};

// Fire-and-forget delivery with three exponential-backoff retries
// (1s → 4s → 16s). Final failures land in Sentry tagged `email_delivery`
// so we can spot outage trends without blocking every signup on Mailjet's
// happy-path latency.
//
// Trade-off: if the process dies between the caller returning and the
// email attempt, the email is lost — but the user can self-recover via
// the resend-verification endpoint or by retrying the originating action.
// Durable cross-restart delivery (Redis queue or a JobModel row) is a
// legitimate follow-up once we have Redis in the stack.
const sendAsyncWithRetry = (params: {
  to: string;
  payload: EmailPayload;
  template: string;
  sentryTags?: Record<string, string>;
}): void => {
  // setImmediate so the HTTP handler resolves first and we don't accidentally
  // inherit a cancelled async context from a slow client.
  setImmediate(async () => {
    const delays = [1_000, 4_000, 16_000];
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await send({ to: params.to, payload: params.payload });
        if (attempt > 0) {
          integrationLog.info(
            `mailjet:send ok template=${params.template} to=${params.to} attempt=${attempt}`,
          );
        }
        return;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        integrationLog.warn(
          `mailjet:send fail template=${params.template} to=${params.to} attempt=${attempt + 1}/${delays.length + 1} reason=${message}`,
        );
        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }

    integrationLog.error(
      `mailjet:send exhausted template=${params.template} to=${params.to} attempts=${delays.length + 1}`,
    );
    captureError(lastError, {
      tags: { email_delivery: params.template, ...(params.sentryTags ?? {}) },
      extra: { to: params.to, attempts: delays.length + 1 },
      fingerprint: ['email_delivery', params.template],
    });
  });
};

// **Awaited** delivery with retry — the batch-campaign counterpart to
// `sendAsyncWithRetry`, and a deliberately separate function rather than a
// refactor of it (F12). Three reasons the harness above cannot be reused:
//
//   1. it is fire-and-forget (`setImmediate`, returns `void`), so a batch
//      loop could never learn whether a send landed, and the claim-then-send
//      CAS in `sendMarketingCampaign` has nothing to roll back on;
//   2. its inner call is `send({ to, payload })` — it **drops `from` and
//      `templateLanguage`**, so a promotional template routed through it
//      would ship from the transactional address with the literal string
//      `[[UNSUB_LINK_EN]]` where the opt-out link should be;
//   3. it is a protected surface: five transactional call sites depend on
//      its exact behaviour.
//
// The ladder is deliberately shorter than the transactional one. Worst-case
// wall time is `batchSize × (attempts−1 delays + round trips)` inside a
// single HTTP request, so a 1s/4s ladder at batch 250 would blow past any
// reverse-proxy timeout. Two retries at 1s and 3s bound a failing recipient
// at ~4s of delay, and `sendMarketingCampaign` additionally stops claiming
// once its own time budget is spent.
const PROMO_RETRY_DELAYS_MS = [1_000, 3_000];

export const sendWithRetry = async (params: {
  to: string;
  payload: EmailPayload;
  template: string;
  from?: string;
  templateLanguage?: boolean;
  headers?: Record<string, string>;
  disableTracking?: boolean;
}): Promise<void> => {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= PROMO_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await send({
        to: params.to,
        payload: params.payload,
        from: params.from,
        templateLanguage: params.templateLanguage,
        headers: params.headers,
        disableTracking: params.disableTracking,
      });
      return;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      // No recipient address in the line — a campaign log is a list of who
      // we mailed, which is exactly the PII a log should not accumulate.
      integrationLog.warn(
        `mailjet:send fail template=${params.template} attempt=${attempt + 1}/${PROMO_RETRY_DELAYS_MS.length + 1} reason=${message}`,
      );
      if (attempt < PROMO_RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, PROMO_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  // Thrown, not swallowed: the caller owns the claim for this recipient and
  // must roll it back. Sentry reporting is the caller's call too — a whole
  // batch failing is one incident, not N.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

// ── Public senders ───────────────────────────────────────
//
// Each `sendXEmail` is the synchronous round-trip (kept for tests and the
// rare caller that genuinely needs to await delivery). Each `sendXEmailAsync`
// is the request-path version that returns immediately and runs delivery
// + retries on the next tick.

export const sendVerificationEmail = async (params: { to: string; token: string }): Promise<void> => {
  await send({ to: params.to, payload: buildVerificationEmail({ token: params.token }) });
};

export const sendVerificationEmailAsync = (params: { to: string; token: string }): void => {
  sendAsyncWithRetry({
    to: params.to,
    payload: buildVerificationEmail({ token: params.token }),
    template: 'verification',
  });
};

export const sendPasswordResetEmail = async (params: { to: string; token: string }): Promise<void> => {
  await send({
    to: params.to,
    payload: buildPasswordResetEmail({ to: params.to, token: params.token }),
  });
};

export const sendPasswordResetEmailAsync = (params: { to: string; token: string }): void => {
  sendAsyncWithRetry({
    to: params.to,
    payload: buildPasswordResetEmail({ to: params.to, token: params.token }),
    template: 'password_reset',
  });
};

export const sendSecurityActionCode = async (params: {
  to: string;
  action: SecurityActionKind;
  code: string;
  expiresInMinutes: number;
}): Promise<void> => {
  await send({
    to: params.to,
    payload: buildSecurityActionCodeEmail({
      action: params.action,
      code: params.code,
      expiresInMinutes: params.expiresInMinutes,
    }),
  });
};

export const sendSecurityActionCodeAsync = (params: {
  to: string;
  action: SecurityActionKind;
  code: string;
  expiresInMinutes: number;
}): void => {
  sendAsyncWithRetry({
    to: params.to,
    payload: buildSecurityActionCodeEmail({
      action: params.action,
      code: params.code,
      expiresInMinutes: params.expiresInMinutes,
    }),
    template: 'security_action',
    sentryTags: { action: params.action },
  });
};

// ── Promotional senders ─────────────────────────────────
//
// Synchronous (await) by design — the admin "send test" backdoor wants
// the round-trip status so the operator sees pass/fail immediately. Real
// bulk campaigns (when we add them) should use a queued worker, not
// loop over this function.

/**
 * The documents-feature campaign sender.
 *
 * Everything a promotional message legally and operationally needs is set
 * HERE rather than left to a caller, because every one of these has a
 * silent-failure mode:
 *
 *   - `from: SENDER_EMAIL_PROMOTIONAL` — otherwise marketing goes out on
 *     the transactional reputation;
 *   - `templateLanguage: true` — without it Mailjet's `[[UNSUB_LINK_EN]]`
 *     ships as literal text, which is the failure mode for a test send to
 *     an address with no ledger row (no `unsubscribeUrl` to substitute);
 *   - `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058) — the mail
 *     client's own unsubscribe button. Without them the reader's only
 *     available "make this stop" control is the spam button;
 *   - `disableTracking` — PLAN A10: no open or click tracking in any new
 *     email, enforced in code rather than in a vendor dashboard.
 */
export const sendDocumentsFeatureEmail = async (params: {
  to: string;
  /** Our own per-contact opt-out URL. Omitted only where no ledger row
   *  exists (dev preview, ad-hoc admin test send) — the renderer then falls
   *  back to Mailjet's hosted link so the footer is never dead. */
  unsubscribeUrl?: string;
}): Promise<void> => {
  await sendWithRetry({
    to: params.to,
    payload: buildDocumentsFeatureEmail({ unsubscribeUrl: params.unsubscribeUrl }),
    template: 'documents_feature',
    from: SENDER_EMAIL_PROMOTIONAL,
    templateLanguage: true,
    headers: params.unsubscribeUrl
      ? {
          'List-Unsubscribe': `<${params.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : undefined,
    disableTracking: true,
  });
};
