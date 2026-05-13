import Mailjet from 'node-mailjet';
import { MAILJET_API_KEY, MAILJET_API_SECRET } from '@conf/env';
import { integrationLog } from '@lib/loggers';
import { captureError } from '@lib/errorReporter';
import {
  buildVerificationEmail,
  buildPasswordResetEmail,
  buildSecurityActionCodeEmail,
  buildOldUserRelaunchEmail,
  buildOldPayingUserThanksEmail,
  type EmailPayload,
  type SecurityActionKind,
} from '@lib/email/templates';

// Transactional sender — verification, password reset, security codes.
// Anything users implicitly opted into by performing an account action.
export const SENDER_EMAIL_ACCOUNT = 'accounts@strive-learning.com';

// Promotional sender — relaunch announcements, marketing campaigns,
// anything that requires opt-out. Kept separate so spam complaints and
// soft-bounces on the marketing stream don't drag down deliverability of
// password reset / verification mail. Until the new domain is verified
// in Mailjet (see MAILJET_SETUP.md / TODO note in adminRoutes), this can
// share the transactional address — set both to the same value.
//
// Mailjet setup required before flipping this to a separate address:
//   1. Add `hello@strive-learning.com` (or your chosen handle) as a
//      verified sender in Mailjet → Senders & Domains.
//   2. Confirm SPF + DKIM DNS records cover the new sender (the
//      `strive-learning.com` domain DKIM almost certainly already does;
//      verify in Mailjet's domain auth panel).
//   3. Optional but recommended: create a dedicated sub-account or a
//      separate Mailjet API key scoped to the promotional sender so
//      transactional throughput isn't affected by marketing rate limits.
export const SENDER_EMAIL_PROMOTIONAL = 'hello@strive-learning.com';

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

export const sendOldUserRelaunchEmail = async (params: { to: string }): Promise<void> => {
  await send({
    to: params.to,
    payload: buildOldUserRelaunchEmail(),
    from: SENDER_EMAIL_PROMOTIONAL,
    // Promotional sends rely on Mailjet's `[[UNSUB_LINK_EN]]` substitution
    // for the unsubscribe footer — enabling the template language is what
    // turns the raw `[[…]]` placeholder into a real per-recipient URL.
    templateLanguage: true,
  });
};

export const sendOldPayingUserThanksEmail = async (params: { to: string }): Promise<void> => {
  await send({
    to: params.to,
    payload: buildOldPayingUserThanksEmail(),
    from: SENDER_EMAIL_PROMOTIONAL,
    templateLanguage: true,
  });
};
