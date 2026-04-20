import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import { hashPassword } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import asyncHandler from 'express-async-handler';
import { changePasswordSchema } from './validation';

/**
 * @swagger
 * /api/auth/change-password:
 *   post:
 *     summary: Change the password for the authenticated user
 *     description: Requires an existing password (CREDENTIALS provider). Bumps tokenVersion to invalidate other sessions; the caller must re-authenticate.
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
export const changePasswordController = asyncHandler(async (req, res) => {
  const { newPassword } = changePasswordSchema.parse(req.body);

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

  const hashedPassword = await hashPassword(newPassword);

  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: { password: hashedPassword },
      $inc: { tokenVersion: 1 },
    },
  );

  res.status(200).json({ data: { message: 'Password changed' } });
});
