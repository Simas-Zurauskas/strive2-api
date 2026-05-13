import 'colors';
import crypto from 'crypto';
import UserModel from '@models/UserModel';
import SecurityActionTokenModel from '@models/SecurityActionTokenModel';
import { decodeAuthToken } from '@lib/auth';
import { TOPUP_CREDITS_PER_USD } from '@lib/creditPricing';
import { signup, type ApiClient } from './apiClient';

// Match a $20 top-up so a persona can run a full chat + multi-lesson + mentor
// flow without hitting `requireCredits` mid-run. Granted as `bonusBalance` to
// mirror the real Stripe top-up path (stripeWebhookService.handleTopupSuccess).
const SEED_TOPUP_USD = 20;
const SEED_TOPUP_CREDITS = SEED_TOPUP_USD * TOPUP_CREDITS_PER_USD;

export interface TestUser {
  userId: string;
  email: string;
  password: string;
  token: string;
}

/**
 * Provision a fresh, verified db user for a single persona run.
 *
 * Flow: call the real signup endpoint → extract the JWT-issued userId →
 * flip `emailVerified=true` in Mongo so `requireVerified` stops rejecting
 * feature routes. We deliberately don't exercise the Mailjet verification
 * round-trip because we don't have access to the plaintext verification
 * token (it's only emitted in the email body).
 *
 * Email domain is the RFC-6761 reserved `.test` TLD so we never collide
 * with a real human inbox and so the pattern is grep-able for cleanup.
 */
export const createVerifiedTestUser = async ({
  baseUrl,
  runId,
  personaSlug,
}: {
  baseUrl: string;
  runId: string;
  personaSlug: string;
}): Promise<TestUser> => {
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const email = `debug-${runId}-${personaSlug}-${randomSuffix}@strive-debug.test`;
  const password = `debug-pass-${crypto.randomBytes(8).toString('hex')}`;

  const token = await signup({ baseUrl, email, password });

  const decoded = decodeAuthToken(token);
  if (!decoded?.id) {
    throw new Error(`signup returned an undecodable token for ${email}`);
  }
  const userId = decoded.id;

  const result = await UserModel.updateOne(
    { _id: userId },
    {
      $set: { emailVerified: true },
      $unset: { emailVerificationToken: 1, emailVerificationExpiry: 1 },
      $inc: { 'credits.bonusBalance': SEED_TOPUP_CREDITS },
    },
  );

  if (result.matchedCount !== 1) {
    throw new Error(`emailVerified flip missed user ${userId} (${email})`);
  }

  return { userId, email, password, token };
};

/**
 * Best-effort cleanup. DELETE /api/auth/delete-account cascades across
 * courses, lessons, progress, recall cards, chat, gamification, and S3 assets
 * (see `services/courseCleanupService.ts`). We swallow failures with a
 * warning so one flaky teardown doesn't mask another persona's result.
 *
 * The endpoint now requires a 6-digit email OTP (see
 * `controlers/auth/deleteAccount.ts` — Mailjet-delivered code keyed on a
 * `SecurityActionToken` row). We don't have access to the inbox in this
 * harness, so we mint a token row directly in Mongo with a hash matching
 * the same `sha256(`${code}:${userId}`)` pepper the service uses, then
 * submit the plaintext code to the API.
 */
export const deleteTestUser = async ({
  client,
  userId,
  email,
}: {
  client: ApiClient;
  userId: string;
  email: string;
}): Promise<void> => {
  try {
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = crypto.createHash('sha256').update(`${code}:${userId}`).digest('hex');
    await SecurityActionTokenModel.create({
      userId,
      action: 'delete_account',
      codeHash,
      attempts: 0,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      usedAt: null,
    });
    await client.deleteAccount({ code });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[testUser] failed to delete ${email}: ${message}`.yellow);
  }
};
