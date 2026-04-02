import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import asyncHandler from 'express-async-handler';
import { generateAuthToken, hashPassword, generateVerificationToken, VERIFICATION_TOKEN_EXPIRY_MS } from '@lib/auth';
import { sendVerificationEmail } from '@services/emailService';
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

  const user = await UserModel.create({
    email,
    password: hashedPassword,
    emailVerificationToken: hashedToken,
    emailVerificationExpiry: new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_MS),
    authProviders: [{ provider: AuthProvider.CREDENTIALS }],
  });

  try {
    await sendVerificationEmail({ to: email, token: plainToken });
  } catch (err) {
    console.error('[API] Failed to send verification email:'.red, err);
    // Don't block signup — user can resend from profile
  }

  res.status(201).json({ data: generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion }) });
});
