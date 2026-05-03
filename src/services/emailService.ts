import Mailjet from 'node-mailjet';
import * as Sentry from '@sentry/node';
import { MAILJET_API_KEY, MAILJET_API_SECRET, FRONTEND_URL } from '@conf/env';
import { integrationLog } from '@lib/loggers';

export const SENDER_EMAIL_ACCOUNT = 'accounts@strive-learning.com';

const mailjet = new Mailjet({
  apiKey: MAILJET_API_KEY,
  apiSecret: MAILJET_API_SECRET,
});

/**
 * Low-level Mailjet send. Callers should prefer `sendVerificationEmailAsync`
 * below — the request-path controllers must never block on Mailjet's p99.
 * This remains exported for tests and for the rare case where the caller
 * genuinely needs a sync round-trip.
 */
export const sendVerificationEmail = async (params: { to: string; token: string }): Promise<void> => {
  const { to, token } = params;
  // The verification URL only needs the token — the server looks the
  // user up by the hashed token directly, so the email address adds no
  // information and removes a small leakage surface (URL stored in
  // browser history, referer headers, downstream mail-relay logs).
  const verificationUrl = `${FRONTEND_URL}/verify-email?token=${token}`;

  await mailjet.post('send', { version: 'v3.1' }).request({
    Messages: [
      {
        From: {
          Email: SENDER_EMAIL_ACCOUNT,
          Name: 'Strive',
        },
        To: [{ Email: to }],
        Subject: 'Verify your email address',
        HTMLPart: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
            <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin-bottom: 16px;">
              Verify your email
            </h1>
            <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
              Thanks for signing up for Strive. Click the button below to verify your email address and get started.
            </p>
            <a href="${verificationUrl}"
               style="display: inline-block; padding: 12px 24px; background: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 600;">
              Verify email address
            </a>
            <p style="font-size: 13px; color: #9ca3af; line-height: 1.6; margin-top: 32px;">
              This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.
            </p>
          </div>
        `,
        TextPart: `Verify your email address\n\nThanks for signing up for Strive. Visit the link below to verify your email:\n\n${verificationUrl}\n\nThis link expires in 24 hours. If you didn't create an account, you can safely ignore this email.`,
      },
    ],
  });
};

/**
 * Fire-and-forget version of `sendVerificationEmail`.
 *
 * The caller returns to the HTTP request immediately; the actual Mailjet
 * round-trip runs on the next tick with three exponential-backoff retries
 * (1s → 4s → 16s). All failures land in Sentry tagged `email_delivery` so
 * we can spot outage trends without blocking every signup on Mailjet's
 * happy-path latency.
 *
 * Trade-off: if the process dies between signup and the email attempt,
 * the email is lost — but the user can always trigger a resend from
 * `/api/auth/resend-verification` or the authenticated equivalent. That's
 * a much smaller loss than a 30-second signup stall during a Mailjet
 * degradation, which would 5xx every signup attempt synchronously.
 *
 * Durable cross-restart delivery (Redis queue, BullMQ, or an email-job
 * row in JobModel) is a legitimate follow-up once we have Redis in the
 * stack. The current in-process approach needs zero new infra.
 */
export const sendVerificationEmailAsync = (params: { to: string; token: string }): void => {
  // Pushed to a microtask so the HTTP handler resolves first and we don't
  // accidentally inherit a cancelled async context from a slow client.
  setImmediate(async () => {
    const delays = [1_000, 4_000, 16_000]; // ms
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await sendVerificationEmail(params);
        if (attempt > 0) {
          integrationLog.info(`mailjet:send ok template=verify to=${params.to} attempt=${attempt}`);
        }
        return;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        integrationLog.warn(
          `mailjet:send fail template=verify to=${params.to} attempt=${attempt + 1}/${delays.length + 1} reason=${message}`,
        );

        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }

    // Exhausted retries — record as a breadcrumb so ops sees the trend.
    // The end user can still self-recover via the resend-verification
    // endpoint; we don't surface this failure to them.
    integrationLog.error(
      `mailjet:send exhausted template=verify to=${params.to} attempts=${delays.length + 1}`,
    );
    Sentry.captureException(lastError, {
      tags: { email_delivery: 'verification' },
      extra: { to: params.to, attempts: delays.length + 1 },
    });
  });
};

/**
 * Low-level Mailjet send for password-reset links. Mirrors `sendVerificationEmail`
 * but kept separate (not parameterised) because the two flows are likely to diverge
 * — different expiry copy, possibly different sender domain, eventually a security-
 * event audit hook on resets. Prefer `sendPasswordResetEmailAsync` from the request
 * path.
 */
export const sendPasswordResetEmail = async (params: { to: string; token: string }): Promise<void> => {
  const { to, token } = params;
  const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(to)}`;

  await mailjet.post('send', { version: 'v3.1' }).request({
    Messages: [
      {
        From: {
          Email: SENDER_EMAIL_ACCOUNT,
          Name: 'Strive',
        },
        To: [{ Email: to }],
        Subject: 'Reset your Strive password',
        HTMLPart: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
            <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin-bottom: 16px;">
              Reset your password
            </h1>
            <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
              We received a request to reset your Strive password. Click the button below to choose a new one.
            </p>
            <a href="${resetUrl}"
               style="display: inline-block; padding: 12px 24px; background: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 600;">
              Reset password
            </a>
            <p style="font-size: 13px; color: #9ca3af; line-height: 1.6; margin-top: 32px;">
              This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.
            </p>
          </div>
        `,
        TextPart: `Reset your Strive password\n\nWe received a request to reset your password. Visit the link below to choose a new one:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.`,
      },
    ],
  });
};

/**
 * Fire-and-forget version of `sendPasswordResetEmail`. Same retry harness as
 * `sendVerificationEmailAsync` (1s/4s/16s with Sentry on final failure). Sentry
 * tag is `email_delivery: 'password_reset'` so dashboards can distinguish the
 * two flows.
 */
export const sendPasswordResetEmailAsync = (params: { to: string; token: string }): void => {
  setImmediate(async () => {
    const delays = [1_000, 4_000, 16_000]; // ms
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await sendPasswordResetEmail(params);
        if (attempt > 0) {
          integrationLog.info(`mailjet:send ok template=password-reset to=${params.to} attempt=${attempt}`);
        }
        return;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        integrationLog.warn(
          `mailjet:send fail template=password-reset to=${params.to} attempt=${attempt + 1}/${delays.length + 1} reason=${message}`,
        );

        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }

    integrationLog.error(
      `mailjet:send exhausted template=password-reset to=${params.to} attempts=${delays.length + 1}`,
    );
    Sentry.captureException(lastError, {
      tags: { email_delivery: 'password_reset' },
      extra: { to: params.to, attempts: delays.length + 1 },
    });
  });
};
