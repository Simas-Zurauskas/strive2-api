import UserModel from '@models/UserModel';
import { generateVerificationToken, VERIFICATION_TOKEN_EXPIRY_MS } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import { sendVerificationEmail } from '@services/emailService';
import asyncHandler from 'express-async-handler';
import { resendVerificationSchema } from './validation';

/**
 * @swagger
 * /api/auth/resend-verification:
 *   post:
 *     summary: Resend the email verification link
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
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
export const resendVerificationController = asyncHandler(async (req, res) => {
  const { email, password } = resendVerificationSchema.parse(req.body);

  const user = await UserModel.findOne({ email }).select('+password');

  if (!user) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  const isValid = await user.comparePassword(password);

  if (!isValid) {
    res.status(401);
    throw new Error('Invalid email or password');
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

  await sendVerificationEmail({ to: email, token: plainToken });

  res.status(200).json({ data: { message: 'Verification email sent' } });
});
