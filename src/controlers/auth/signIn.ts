import UserModel from '@models/UserModel';
import asyncHandler from 'express-async-handler';
import { generateAuthToken } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import { AuthProvider } from '@lib/constants';
import { signInSchema } from './validation';

/**
 * @swagger
 * /api/auth/signin:
 *   post:
 *     summary: Sign in with email and password
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
 *                   type: string
 */
export const signInController = asyncHandler(async (req, res) => {
  const { email, password } = signInSchema.parse(req.body);

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

  // Enforce email verification for credential-based accounts
  const hasCredentials = user.authProviders.some((p) => p.provider === AuthProvider.CREDENTIALS);
  if (hasCredentials && !user.emailVerified) {
    res.status(401);
    throw new AppError('Please verify your email before signing in', { errorCode: 'EMAIL_NOT_VERIFIED' });
  }

  res.status(200).json({ data: generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion }) });
});
