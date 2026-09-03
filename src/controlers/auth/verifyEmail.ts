import UserModel from '@models/UserModel';
import { hashVerificationToken } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import asyncHandler from 'express-async-handler';
import { analytics } from '@lib/analytics';
import { enrolVerifiedContact } from '@services/marketingContactService';
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
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *                 description: >
 *                   The verification token from the user's email link.
 *                   Hashed server-side and looked up directly against
 *                   `User.emailVerificationToken`. No `email` field is
 *                   required — the hash is the sole identifier.
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
  const { token } = verifyEmailSchema.parse(req.body);

  // Look the user up directly by the hashed token. The hash is unique
  // per user (32-byte random source) so this is a single-row lookup.
  // No `email` is required from the client — the hash is the identifier.
  const hashedToken = hashVerificationToken(token);

  const user = await UserModel.findOne({ emailVerificationToken: hashedToken }).select(
    '+emailVerificationToken +emailVerificationExpiry',
  );

  if (!user) {
    // Either the token was never issued, was already consumed (the
    // controller clears the field on success), or the user was deleted.
    // The "already verified" branch below distinguishes the consumed-
    // token case for users who click an old link after success — but
    // only when the lookup matches. Once we clear the field, any reuse
    // returns INVALID rather than ALREADY_VERIFIED.
    res.status(400);
    throw new AppError('Invalid verification link', { errorCode: 'EMAIL_VERIFICATION_INVALID' });
  }

  if (user.emailVerified) {
    res.status(400);
    throw new AppError('Email is already verified', { errorCode: 'EMAIL_ALREADY_VERIFIED' });
  }

  if (!user.emailVerificationExpiry) {
    res.status(400);
    throw new AppError('Invalid verification link', { errorCode: 'EMAIL_VERIFICATION_INVALID' });
  }

  if (user.emailVerificationExpiry < new Date()) {
    res.status(410);
    throw new AppError('Verification link has expired. Please request a new one.', {
      errorCode: 'EMAIL_VERIFICATION_EXPIRED',
    });
  }

  user.emailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpiry = undefined;
  await user.save();

  // Enrol the freshly-verified address in the marketing audience (PLAN
  // A4/F15). "Emailable by default" is established by the at-collection
  // notice under the sign-up button, not by a pre-ticked box — so the basis
  // recorded here is `soft_opt_in` against that notice's version, never
  // `consent`. Only the profile toggle may write `consent`.
  //
  // `$setOnInsert` only: if a row already exists it is left exactly as it
  // is, so a returning address that previously opted out is NOT resurrected
  // (PLAN A2b). Nothing here touches Mailjet, so `addforce` — the action
  // that clears an unsubscribe flag — is unreachable from this path.
  //
  // Best-effort: a ledger blip must never fail an email verification, which
  // is the user's route into the product.
  // Extracted to `enrolVerifiedContact` so the Google OAuth path — which sets
  // emailVerified directly and never reaches this controller — can share it.
  // Mechanism here is unchanged: same filter, same $setOnInsert, same
  // swallow-and-report. One observable difference: the bgError context label
  // moved from 'marketingContact.upsertOnVerify' to
  // 'marketingContact.enrolVerifiedContact', so any alert keyed on the old
  // string loses continuity at this deploy.
  await enrolVerifiedContact({ userId: user._id, email: user.email });

  const userId = user._id.toString();
  const createdAtMs = user.createdAt instanceof Date ? user.createdAt.getTime() : null;
  const timeToVerifySeconds = createdAtMs
    ? Math.max(0, Math.round((Date.now() - createdAtMs) / 1000))
    : undefined;
  analytics.setUserProps(userId, { email_verified: true });
  analytics.track(userId, 'email_verified', {
    ...(timeToVerifySeconds !== undefined && { time_to_verify_seconds: timeToVerifySeconds }),
  });

  res.status(200).json({ data: { message: 'Email verified successfully' } });
});
