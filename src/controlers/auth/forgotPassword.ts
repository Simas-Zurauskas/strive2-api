import UserModel from '@models/UserModel';
import { generateVerificationToken, PASSWORD_RESET_TOKEN_EXPIRY_MS } from '@lib/auth';
import { sendPasswordResetEmailAsync } from '@services/emailService';
import asyncHandler from 'express-async-handler';
import { forgotPasswordSchema } from './validation';

/**
 * @swagger
 * /api/auth/forgot-password:
 *   post:
 *     summary: Request a password reset link
 *     description: Always responds 200 with a generic message regardless of whether the email exists, to prevent account enumeration.
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
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
 */
export const forgotPasswordController = asyncHandler(async (req, res) => {
  const { email } = forgotPasswordSchema.parse(req.body);

  const user = await UserModel.findOne({ email }).select('_id');

  // Critical: always return the same response shape regardless of whether
  // the account exists. Branching the response (or omitting the email send
  // entirely on a missing user) would let unauthenticated callers enumerate
  // registered emails. Same enumeration-safety pattern as resendVerification.
  if (user) {
    const { plainToken, hashedToken } = generateVerificationToken();

    await UserModel.updateOne(
      { _id: user._id },
      {
        passwordResetToken: hashedToken,
        passwordResetExpiry: new Date(Date.now() + PASSWORD_RESET_TOKEN_EXPIRY_MS),
      },
    );

    sendPasswordResetEmailAsync({ to: email, token: plainToken });
  }

  res.status(200).json({
    data: { message: 'If an account exists for that email, a reset link has been sent.' },
  });
});
