import UserModel from '@models/UserModel';
import { generateVerificationToken, VERIFICATION_TOKEN_EXPIRY_MS } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import { sendVerificationEmailAsync } from '@services/emailService';
import asyncHandler from 'express-async-handler';

/**
 * @swagger
 * /api/auth/resend-verification-authenticated:
 *   post:
 *     summary: Resend verification email for authenticated user
 *     tags:
 *       - Auth
 *     security:
 *       - bearerAuth: []
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
export const resendVerificationAuthenticatedController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const user = await UserModel.findById(userId);

  if (!user) {
    res.status(401);
    throw new Error('Not authenticated');
  }

  if (user.emailVerified) {
    res.status(400);
    throw new AppError('Email is already verified', { errorCode: 'EMAIL_ALREADY_VERIFIED' });
  }

  const { plainToken, hashedToken } = generateVerificationToken();

  await UserModel.updateOne(
    { _id: user._id },
    {
      emailVerificationToken: hashedToken,
      emailVerificationExpiry: new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_MS),
    },
  );

  sendVerificationEmailAsync({ to: user.email, token: plainToken });

  res.status(200).json({ data: { message: 'Verification email sent' } });
});
