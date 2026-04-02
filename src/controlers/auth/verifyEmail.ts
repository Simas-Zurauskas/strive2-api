import UserModel from '@models/UserModel';
import { hashVerificationToken } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import asyncHandler from 'express-async-handler';
import { verifyEmailSchema } from './validation';

/**
 * @swagger
 * /api/auth/verify-email:
 *   post:
 *     summary: Verify a user's email address
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, email]
 *             properties:
 *               token:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
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
export const verifyEmailController = asyncHandler(async (req, res) => {
  const { token, email } = verifyEmailSchema.parse(req.body);

  const user = await UserModel.findOne({ email }).select(
    '+emailVerificationToken +emailVerificationExpiry',
  );

  if (!user) {
    res.status(400);
    throw new AppError('Invalid verification link', { errorCode: 'EMAIL_VERIFICATION_INVALID' });
  }

  if (user.emailVerified) {
    res.status(400);
    throw new AppError('Email is already verified', { errorCode: 'EMAIL_ALREADY_VERIFIED' });
  }

  if (!user.emailVerificationToken || !user.emailVerificationExpiry) {
    res.status(400);
    throw new AppError('Invalid verification link', { errorCode: 'EMAIL_VERIFICATION_INVALID' });
  }

  if (user.emailVerificationExpiry < new Date()) {
    res.status(410);
    throw new AppError('Verification link has expired. Please request a new one.', {
      errorCode: 'EMAIL_VERIFICATION_EXPIRED',
    });
  }

  const hashedToken = hashVerificationToken(token);

  if (hashedToken !== user.emailVerificationToken) {
    res.status(400);
    throw new AppError('Invalid verification link', { errorCode: 'EMAIL_VERIFICATION_INVALID' });
  }

  user.emailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpiry = undefined;
  await user.save();

  res.status(200).json({ data: { message: 'Email verified successfully' } });
});
