import UserModel from '@models/UserModel';
import { generateVerificationToken, VERIFICATION_TOKEN_EXPIRY_MS } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import { sendVerificationEmailAsync } from '@services/emailService';
import asyncHandler from 'express-async-handler';

// Minimum spacing between sends per user. The unauthenticated counterpart
// is gated by `emailDeliveryPerEmail` (3 / 15min) at the route layer, but
// the authenticated route was previously only IP-bucketed — a single
// signed-in user could mash the button and burn Mailjet quota plus spam
// their own inbox. 60s mirrors the security-action service spacing.
const RESEND_MIN_INTERVAL_MS = 60 * 1000;

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

  // Server-side cooldown. We don't carry a dedicated timestamp; the
  // existing `emailVerificationExpiry` field is rewritten on every send
  // to `now + VERIFICATION_TOKEN_EXPIRY_MS`, so `expiry - now` measures
  // time-since-last-send. A value under 60s means the last send was
  // within the cooldown window. Returns retry-after seconds in `meta`
  // so the client can mirror the wait visually.
  if (user.emailVerificationExpiry) {
    const msSinceLastSend = VERIFICATION_TOKEN_EXPIRY_MS - (user.emailVerificationExpiry.getTime() - Date.now());
    if (msSinceLastSend >= 0 && msSinceLastSend < RESEND_MIN_INTERVAL_MS) {
      const retryAfterSeconds = Math.ceil((RESEND_MIN_INTERVAL_MS - msSinceLastSend) / 1000);
      throw new AppError(
        `Please wait ${retryAfterSeconds}s before requesting another verification email.`,
        {
          errorCode: 'VERIFICATION_RESEND_TOO_SOON',
          statusCode: 429,
          meta: { retryAfterSeconds },
        },
      );
    }
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
