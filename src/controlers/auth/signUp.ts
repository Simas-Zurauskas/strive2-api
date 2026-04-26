import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import asyncHandler from 'express-async-handler';
import { generateAuthToken, hashPassword, generateVerificationToken, VERIFICATION_TOKEN_EXPIRY_MS } from '@lib/auth';
import { FREE_PERIOD_DAYS } from '@lib/creditPricing';
import { sendVerificationEmailAsync } from '@services/emailService';
import { resolveSignupAllowance } from '@services/abuseLogService';
import { signUpSchema } from './validation';

/**
 * @swagger
 * /api/auth/signup:
 *   post:
 *     summary: Register a new user
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
 *                 minLength: 8
 *                 maxLength: 128
 *     responses:
 *       201:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: string
 */
export const signUpController = asyncHandler(async (req, res) => {
  const { email, password } = signUpSchema.parse(req.body);

  const userExists = await UserModel.exists({ email });

  if (userExists) {
    res.status(409);
    throw new Error('An account with this email already exists');
  }

  const hashedPassword = await hashPassword(password);

  const { plainToken, hashedToken } = generateVerificationToken();

  // Abuse-log check: if this canonical email was seen + deleted within the
  // retention window, create the account with zero credits so the user can
  // still sign up + subscribe but can't harvest free-tier credits again.
  // Silent from the client's perspective — no "blocked" error, just no grant.
  const { allowanceBalance, allowanceGranted } = await resolveSignupAllowance(email);
  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + FREE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const user = await UserModel.create({
    email,
    password: hashedPassword,
    emailVerificationToken: hashedToken,
    emailVerificationExpiry: new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_MS),
    authProviders: [{ provider: AuthProvider.CREDENTIALS }],
    credits: {
      allowanceBalance,
      allowanceGranted,
      periodStart,
      periodEnd,
      bonusBalance: 0,
    },
  });

  // Fire-and-forget: signup returns to the client before the Mailjet round
  // trip. Retries + Sentry capture happen inside `sendVerificationEmailAsync`.
  // If every retry fails the user is still signed up and can trigger
  // `/api/auth/resend-verification` manually.
  sendVerificationEmailAsync({ to: email, token: plainToken });

  // ⚠ A JWT is issued here BEFORE the user verifies their email. That
  // contradicts `signIn`, which refuses unverified users with
  // EMAIL_NOT_VERIFIED — meaning a signup-then-logout-then-signin cycle
  // locks the user out until they verify, but a signup-then-keep-going
  // flow gives them full authenticated access. Changing this requires the
  // client to handle a signup response that has no session (stay on
  // check-email) rather than an immediate session start. Deferred until
  // the client change can be coordinated.
  res.status(201).json({ data: generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion }) });
});
