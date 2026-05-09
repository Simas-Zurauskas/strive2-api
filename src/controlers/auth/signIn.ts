import UserModel from '@models/UserModel';
import asyncHandler from 'express-async-handler';
import { generateAuthToken } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import { AuthProvider } from '@lib/constants';
import { analytics } from '@lib/analytics';
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

  // No user found: do not fire `signin_failed` — without a userId we'd
  // either drop the event or leak the email as a synthetic distinct id.
  // Failure rate for real accounts is captured by the two branches below.
  if (!user) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  const isValid = await user.comparePassword(password);
  const userId = user._id.toString();

  if (!isValid) {
    analytics.track(userId, 'signin_failed', {
      auth_method: 'credentials',
      failure_reason: 'bad_credentials',
    });
    res.status(401);
    throw new Error('Invalid email or password');
  }

  // Enforce email verification for credential-based accounts
  const hasCredentials = user.authProviders.some((p) => p.provider === AuthProvider.CREDENTIALS);
  if (hasCredentials && !user.emailVerified) {
    analytics.track(userId, 'signin_failed', {
      auth_method: 'credentials',
      failure_reason: 'unverified',
    });
    res.status(401);
    throw new AppError('Please verify your email before signing in', { errorCode: 'EMAIL_NOT_VERIFIED' });
  }

  analytics.track(userId, 'signin_succeeded', { auth_method: 'credentials' });

  res.status(200).json({ data: generateAuthToken({ id: userId, tokenVersion: user.tokenVersion }) });
});
