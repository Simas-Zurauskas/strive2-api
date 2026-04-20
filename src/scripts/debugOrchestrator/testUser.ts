import 'colors';
import crypto from 'crypto';
import UserModel from '@models/UserModel';
import { decodeAuthToken } from '@lib/auth';
import { signup, type ApiClient } from './apiClient';

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
    },
  );

  if (result.matchedCount !== 1) {
    throw new Error(`emailVerified flip missed user ${userId} (${email})`);
  }

  return { userId, email, password, token };
};

/**
 * Best-effort cleanup. DELETE /api/auth/delete-account cascades across
 * courses, lessons, progress, insights, chat, gamification, and S3 assets
 * (see `services/courseCleanupService.ts`). We swallow failures with a
 * warning so one flaky teardown doesn't mask another persona's result.
 */
export const deleteTestUser = async ({
  client,
  password,
  email,
}: {
  client: ApiClient;
  password: string;
  email: string;
}): Promise<void> => {
  try {
    await client.deleteAccount({ password });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[testUser] failed to delete ${email}: ${message}`.yellow);
  }
};
