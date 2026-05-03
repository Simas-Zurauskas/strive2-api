import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import { hashPassword, generateAuthToken } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import asyncHandler from 'express-async-handler';
import { changePasswordSchema } from './validation';
import { consumeSecurityActionCode } from '@services/securityActionService';

/**
 * @swagger
 * /api/auth/change-password:
 *   post:
 *     summary: Change the password for the authenticated user
 *     description: |
 *       Two-factor: requires a fresh 6-digit confirmation code emailed to the
 *       user via `/api/auth/security-action/request-code` with action=change_password.
 *       The code is the gate — without it a stolen JWT cannot rotate the
 *       password. On success bumps tokenVersion to invalidate every other
 *       session AND mints a fresh JWT for the caller (returned as
 *       `data.token`) so the calling session stays alive while every other
 *       device is forced to re-authenticate.
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
export const changePasswordController = asyncHandler(async (req, res) => {
  const { newPassword, code } = changePasswordSchema.parse(req.body);

  const user = await UserModel.findById(req.userId).select('+password authProviders');

  if (!user) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  const hasCredentials = user.authProviders.some((p) => p.provider === AuthProvider.CREDENTIALS);

  if (!user.password || !hasCredentials) {
    res.status(400);
    throw new AppError('No password is set for this account', {
      errorCode: 'PASSWORD_NOT_SET',
    });
  }

  // Verify the email-delivered confirmation code BEFORE hashing the new
  // password (avoid wasted bcrypt work on bad attempts) and BEFORE the
  // tokenVersion bump (avoid invalidating sessions on a no-op).
  // consumeSecurityActionCode throws AppError with the right errorCode +
  // statusCode; errorMiddleware surfaces it to the client unchanged.
  await consumeSecurityActionCode({
    userId: req.userId!,
    action: 'change_password',
    code,
  });

  const hashedPassword = await hashPassword(newPassword);

  // Read-after-write to capture the new tokenVersion. We could compute it as
  // `user.tokenVersion + 1`, but reading the post-update document is
  // resilient to a parallel mutation that also bumped the version (e.g. a
  // concurrent logout) — we always sign the JWT against the value the DB
  // actually agreed on.
  const updated = await UserModel.findOneAndUpdate(
    { _id: user._id },
    {
      $set: { password: hashedPassword },
      $inc: { tokenVersion: 1 },
    },
    { returnDocument: 'after', projection: { tokenVersion: 1 } },
  );

  if (!updated) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  // Mint a fresh JWT carrying the new tokenVersion. Every OTHER session
  // (still holding the prior version) is now invalid; the caller swaps in
  // this token via NextAuth `session.update()` and stays signed in.
  const token = generateAuthToken({
    id: updated._id.toString(),
    tokenVersion: updated.tokenVersion,
  });

  res.status(200).json({ data: { message: 'Password changed', token } });
});
