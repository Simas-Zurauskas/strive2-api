import { GOOGLE_CLIENT_ID } from '@conf/env';
import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import asyncHandler from 'express-async-handler';
import { OAuth2Client } from 'google-auth-library';
import { generateAuthToken } from '@lib/auth';
import { FREE_PERIOD_DAYS } from '@lib/creditPricing';
import { resolveSignupAllowance } from '@services/abuseLogService';
import { awardSignupGrantIfAny } from '@services/signupCreditGrantService';
import { analytics } from '@lib/analytics';
import { googleAuthSchema } from './validation';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * @swagger
 * /api/auth/google:
 *   post:
 *     summary: Authenticate or register via Google
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: string
 */
export const googleAuthController = asyncHandler(async (req, res) => {
  const { idToken } = googleAuthSchema.parse(req.body);

  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload?.email) {
    res.status(400);
    throw new Error('Unable to verify Google account');
  }

  // Google tokens may carry an email the user hasn't proven ownership of
  // (e.g., workspace-admin-added alias, unverified gmail). Accepting those
  // would let an attacker sign in as a victim who uses the same address
  // for credentials auth. Require Google's own verification step.
  if (!payload.email_verified) {
    res.status(400);
    throw new Error('Google account email is not verified');
  }

  const { email, sub, picture, name } = payload;

  // Account-linking hijack guard. Scenario: an attacker signs up with
  // `victim@x.com` via credentials, never verifies (so the credentials
  // login is blocked). The victim later signs in with Google using the
  // same address — Google proves they own the inbox. We merge onto the
  // existing row (don't orphan their history), but we must neutralize the
  // attacker's foothold:
  //   1. strip the password and the CREDENTIALS auth provider so the
  //      attacker's password no longer unlocks the account;
  //   2. bump `tokenVersion` to kill the pre-verification JWT that signup
  //      issued — otherwise it'd start passing the `requireVerified` gate
  //      the moment we set `emailVerified: true`.
  // A legit owner who signed up with credentials but forgot to verify is
  // affected the same way; they can reset their password later (or keep
  // using Google). Acceptable trade-off vs. silent takeover.
  //
  // The pre-step ALSO serves as a dedupe: we $pull every GOOGLE entry,
  // then $push exactly one canonical one in the upsert below. Without this
  // every Google sign-in would append another GOOGLE subdoc — Mongoose
  // auto-generates a per-entry _id, so $addToSet's deep-equality check
  // never matches an existing entry. Pulling-then-pushing keeps the array
  // idempotent and lazily cleans up legacy duplicate rows.
  const existing = await UserModel.findOne({ email }).select('emailVerified authProviders').lean();
  if (existing) {
    const isUnverifiedCredentials = !existing.emailVerified &&
      existing.authProviders.some((p) => p.provider === AuthProvider.CREDENTIALS);

    const providersToPull = isUnverifiedCredentials
      ? [AuthProvider.CREDENTIALS, AuthProvider.GOOGLE]
      : [AuthProvider.GOOGLE];

    await UserModel.updateOne(
      { email },
      {
        ...(isUnverifiedCredentials && {
          $unset: { password: '' },
          $inc: { tokenVersion: 1 },
        }),
        $pull: { authProviders: { provider: { $in: providersToPull } } },
      },
    );
  }

  // Brand-new user (account didn't exist before this request) → abuse-log
  // check gates the free-tier grant. Existing accounts pass through
  // unchanged; their credit state (whatever it currently is) is preserved.
  // Google OAuth never needs an email-verification step, so we also populate
  // the credits period on insert since the Mongoose default would otherwise
  // be shadowed by $setOnInsert conflict resolution.
  const onInsertCredits = existing
    ? {}
    : await (async () => {
      const { allowanceBalance, allowanceGranted } = await resolveSignupAllowance(email);
      const periodStart = new Date();
      const periodEnd = new Date(periodStart.getTime() + FREE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
      return {
        credits: {
          allowanceBalance,
          allowanceGranted,
          periodStart,
          periodEnd,
          bonusBalance: 0,
        },
      };
    })();

  const user = await UserModel.findOneAndUpdate(
    { email },
    {
      $set: {
        emailVerified: true,
        ...(name && { name }),
        ...(picture && { image: picture }),
      },
      $push: {
        authProviders: { provider: AuthProvider.GOOGLE, providerId: sub },
      },
      $setOnInsert: { email, ...onInsertCredits },
    },
    { upsert: true, returnDocument: 'after' },
  );

  if (!user) {
    res.status(500);
    throw new Error('Failed to create or update user');
  }

  const userId = user._id.toString();
  // `existing` was the pre-upsert lookup — if it was null this user was
  // freshly created in the upsert above. Apply pre-provisioned signup grant
  // (old-user relaunch list) before analytics so the topline `signup_completed`
  // event reflects the bonus that's already on their balance.
  if (!existing) {
    await awardSignupGrantIfAny({ userId, email });
  }

  // Fire `signup_completed` for new users and `signin_succeeded` for returning
  // ones so the funnel split (acquisition vs reactivation) stays clean.
  if (!existing) {
    analytics.setUserProps(userId, {
      $email: email,
      ...(name ? { $name: name } : {}),
      $created: user.createdAt?.toISOString() ?? new Date().toISOString(),
      email_verified: true,
      auth_method: 'google',
      plan: 'free',
    });
    analytics.track(userId, 'signup_completed', {
      auth_method: 'google',
      user_id: userId,
    });
  } else {
    analytics.track(userId, 'signin_succeeded', { auth_method: 'google' });
  }

  res.status(200).json({ data: generateAuthToken({ id: userId, tokenVersion: user.tokenVersion }) });
});
