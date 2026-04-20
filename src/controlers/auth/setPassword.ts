import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import { hashPassword } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import asyncHandler from 'express-async-handler';
import { setPasswordSchema } from './validation';

/**
 * @swagger
 * /api/auth/set-password:
 *   post:
 *     summary: Set a password on a Google-only account
 *     description: Adds a password (and the CREDENTIALS provider) to an authenticated user that does not yet have one. Bumps tokenVersion, so the caller must re-authenticate after success.
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
 *             required: [newPassword]
 *             properties:
 *               newPassword:
 *                 type: string
 *                 minLength: 8
 *                 maxLength: 128
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
 *                   properties:
 *                     message:
 *                       type: string
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
 */
export const setPasswordController = asyncHandler(async (req, res) => {
  const { newPassword } = setPasswordSchema.parse(req.body);

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

  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: { password: hashedPassword, authProviders: nextProviders },
      $inc: { tokenVersion: 1 },
    },
  );

  res.status(200).json({ data: { message: 'Password set' } });
});
