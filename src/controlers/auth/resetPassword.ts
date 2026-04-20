import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import { hashPassword, hashVerificationToken } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import asyncHandler from 'express-async-handler';
import { resetPasswordSchema } from './validation';

/**
 * @swagger
 * /api/auth/reset-password:
 *   post:
 *     summary: Reset a password using a token from the reset email
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, token, newPassword]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               token:
 *                 type: string
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
 *       410:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const resetPasswordController = asyncHandler(async (req, res) => {
  const { email, token, newPassword } = resetPasswordSchema.parse(req.body);

  const user = await UserModel.findOne({ email }).select(
    '+passwordResetToken +passwordResetExpiry authProviders',
  );

  if (!user || !user.passwordResetToken || !user.passwordResetExpiry) {
    res.status(400);
    throw new AppError('Invalid reset link', { errorCode: 'PASSWORD_RESET_INVALID' });
  }

  if (user.passwordResetExpiry < new Date()) {
    res.status(410);
    throw new AppError('Reset link has expired. Please request a new one.', {
      errorCode: 'PASSWORD_RESET_EXPIRED',
    });
  }

  const hashedToken = hashVerificationToken(token);

  if (hashedToken !== user.passwordResetToken) {
    res.status(400);
    throw new AppError('Invalid reset link', { errorCode: 'PASSWORD_RESET_INVALID' });
  }

  const hashedPassword = await hashPassword(newPassword);

  // Rebuild authProviders client-side rather than $addToSet'ing CREDENTIALS:
  // legacy entries (written before the schema's `_id: false`) still carry
  // auto-generated _ids, so $addToSet's deep-equality compares an existing
  // {provider, _id} against the incoming {provider} and never matches —
  // appending a duplicate every time. Stripping then re-adding exactly one
  // canonical entry sidesteps this and lazily cleans up legacy duplicate
  // rows. The whole change ships in one atomic updateOne.
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
      $unset: { passwordResetToken: '', passwordResetExpiry: '' },
      $inc: { tokenVersion: 1 },
    },
  );

  res.status(200).json({ data: { message: 'Password reset successfully' } });
});
