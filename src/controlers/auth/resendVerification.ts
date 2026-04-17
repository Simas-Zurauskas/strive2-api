import UserModel from '@models/UserModel';
import { generateVerificationToken, VERIFICATION_TOKEN_EXPIRY_MS } from '@lib/auth';
import { sendVerificationEmailAsync } from '@services/emailService';
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
 *       401:
 *         description: Invalid email or password. Returned identically whether the email is unknown or the password is wrong — the endpoint intentionally does not disclose which.
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

  // Always respond 200 past this point. Returning a distinct
  // `EMAIL_ALREADY_VERIFIED` error let an unauthenticated caller who knew a
  // user's password enumerate verification state. We now silently skip the
  // send for already-verified accounts: the user gets no email, won't
  // complete verification (they don't need to), and the signal to a
  // credential-stuffing attacker is identical to a normal send.
  //
  // The authenticated version of this endpoint (`/resend-verification-authenticated`)
  // still returns the distinct error because by then the caller IS the
  // account owner — no enumeration risk, and they benefit from the clear
  // "you're already verified" signal.
  if (!user.emailVerified) {
    const { plainToken, hashedToken } = generateVerificationToken();

    await UserModel.updateOne(
      { _id: user._id },
      {
        emailVerificationToken: hashedToken,
        emailVerificationExpiry: new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_MS),
      },
    );

    sendVerificationEmailAsync({ to: email, token: plainToken });
  }

  res.status(200).json({ data: { message: 'Verification email sent' } });
});
