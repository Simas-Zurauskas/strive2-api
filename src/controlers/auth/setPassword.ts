import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import { hashPassword, generateAuthToken } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import asyncHandler from 'express-async-handler';
import { setPasswordSchema } from './validation';
import { consumeSecurityActionCode } from '@services/securityActionService';
import { analytics } from '@lib/analytics';

/**
 * @swagger
 * /api/auth/set-password:
 *   post:
 *     summary: Set a password on a Google-only account
 *     description: |
 *       Two-factor: requires a fresh 6-digit confirmation code emailed to the
 *       user via `/api/auth/security-action/request-code` with action=set_password.
 *       Without the code a stolen JWT could attach a CREDENTIALS provider with
 *       an attacker-controlled password and lock out the legitimate owner.
 *       On success bumps tokenVersion to invalidate every other session AND
 *       mints a fresh JWT for the caller (returned as `data.token`) so the
 *       calling session stays alive while every other device is forced to
 *       re-authenticate.
 *     tags:
 *       - Auth
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [newPassword, code]
 *             properties:
 *               newPassword:
 *                 type: string
 *                 minLength: 8
 *                 maxLength: 128
 *               code:
 *                 type: string
 *                 description: 6-digit confirmation code from the email.
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
 *                   required: [token]
 *                   properties:
 *                     message:
 *                       type: string
 *                     token:
 *                       type: string
 *                       description: Fresh JWT bound to the new tokenVersion. The client should swap this in to keep the calling session alive.
 *       400:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       401:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       429:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const setPasswordController = asyncHandler(async (req, res) => {
  const { newPassword, code } = setPasswordSchema.parse(req.body);

  const user = await UserModel.findById(req.userId).select('+password authProviders');

  if (!user) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  const hasCredentials = user.authProviders.some((p) => p.provider === AuthProvider.CREDENTIALS);

  if (user.password || hasCredentials) {
    res.status(400);
    throw new AppError('A password is already set for this account', {
      errorCode: 'PASSWORD_ALREADY_SET',
    });
  }

  // Verify the email-delivered confirmation code BEFORE hashing the new
  // password (avoid wasted bcrypt work on bad attempts) and BEFORE the
  // tokenVersion bump (avoid invalidating sessions on a no-op).
  await consumeSecurityActionCode({
    userId: req.userId!,
    action: 'set_password',
    code,
  });
  analytics.track(req.userId!, 'security_action_otp_consumed', { action: 'set_password' });

  const hashedPassword = await hashPassword(newPassword);

  // Rebuild authProviders client-side rather than $addToSet'ing CREDENTIALS.
  // The PASSWORD_ALREADY_SET guard above means CREDENTIALS shouldn't be
  // present here, but we still strip-and-re-add to defend against legacy
  // rows where a CREDENTIALS entry might exist without a `password` (or with
  // a stale auto-generated _id) — see resetPassword.ts for the full rationale.
  const nextProviders = [
    ...user.authProviders
      .filter((p) => p.provider !== AuthProvider.CREDENTIALS)
      .map((p) => ({ provider: p.provider, ...(p.providerId && { providerId: p.providerId }) })),
    { provider: AuthProvider.CREDENTIALS },
  ];

  // Read-after-write so the JWT we sign carries the same tokenVersion the DB
  // committed to (cf. changePassword.ts for the rationale).
  const updated = await UserModel.findOneAndUpdate(
    { _id: user._id },
    {
      $set: { password: hashedPassword, authProviders: nextProviders },
      $inc: { tokenVersion: 1 },
    },
    { returnDocument: 'after', projection: { tokenVersion: 1 } },
  );

  if (!updated) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  const token = generateAuthToken({
    id: updated._id.toString(),
    tokenVersion: updated.tokenVersion,
  });

  res.status(200).json({ data: { message: 'Password set', token } });
});
