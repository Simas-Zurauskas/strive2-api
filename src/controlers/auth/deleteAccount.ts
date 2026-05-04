import asyncHandler from 'express-async-handler';
import UserModel from '@models/UserModel';
import CourseModel from '@models/CourseModel';
import CreditLedgerModel from '@models/CreditLedgerModel';
import JobModel from '@models/JobModel';
import CourseDesignChatModel from '@models/CourseDesignChatModel';
import LessonMentorChatModel from '@models/LessonMentorChatModel';
import CourseMentorChatModel from '@models/CourseMentorChatModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import UserRecallProgressModel from '@models/UserRecallProgressModel';
import UserGamificationModel from '@models/UserGamificationModel';
import { cleanupCourseContent } from '@services/courseCleanupService';
import { recordAccountDeletion } from '@services/abuseLogService';
import { cancelAllSubscriptionsForCustomer } from '@services/stripeService';
import { consumeSecurityActionCode } from '@services/securityActionService';
import { bgError } from '@lib/bg';
import { deleteAccountSchema } from './validation';

/**
 * @swagger
 * /api/auth/delete-account:
 *   delete:
 *     summary: Delete the authenticated user's account and all associated data
 *     description: |
 *       Two-factor: requires a fresh 6-digit confirmation code emailed to the
 *       user via `/api/auth/security-action/request-code` with action=delete_account.
 *       Applies uniformly to credentials and OAuth users — a stolen JWT alone
 *       cannot delete the account.
 *     tags:
 *       - Auth
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code:
 *                 type: string
 *                 description: 6-digit confirmation code from the email.
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
 *                   required: [deleted]
 *                   properties:
 *                     deleted:
 *                       type: boolean
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
 *       429:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const deleteAccountController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const user = await UserModel.findById(userId);

  if (!user) {
    res.status(401);
    throw new Error('Not authenticated');
  }

  // Email-OTP gate. Replaces the prior password-only check, which:
  //   1. Was bypassed entirely for OAuth-only users (Google sign-in users
  //      had no password and could be deleted with just a stolen JWT).
  //   2. Was insufficient for credentials users — a stolen token + a
  //      keylogged password is the same single point of compromise.
  // The code is emailed to the user's verified address; an attacker
  // controlling only the JWT can't read it.
  const { code } = deleteAccountSchema.parse(req.body);
  await consumeSecurityActionCode({
    userId,
    action: 'delete_account',
    code,
  });

  const courseIds = await CourseModel.find({ userId: user._id }).distinct('_id');

  // Delegate per-course cleanup to the same primitive `deleteCourse` uses so
  // the two deletion paths can't drift when new course-scoped models are added.
  // Covers lesson content, quiz content, chat, progress, recall cards,
  // recall-progress, and S3 assets under `lessons/{courseId}/`.
  await Promise.all(courseIds.map((id) => cleanupCourseContent(id.toString())));

  await Promise.all([
    JobModel.deleteMany({ userId: user._id }),
    UserLessonProgressModel.deleteMany({ userId: user._id }),
    UserModuleQuizProgressModel.deleteMany({ userId: user._id }),
    UserRecallProgressModel.deleteMany({ userId: user._id }),
    CourseDesignChatModel.deleteMany({ userId: user._id }),
    // Defense-in-depth user-scoped wipe — `cleanupCourseContent` above
    // already handles mentor chats per owned course, but a stray row left
    // by a foreign-key drift would persist indefinitely without this.
    // Mirrors the `CourseDesignChatModel` pattern.
    LessonMentorChatModel.deleteMany({ userId: user._id }),
    // Same defense-in-depth wipe as LessonMentorChat — `cleanupCourseContent`
    // covers the per-course rows, but a stray foreign-key drift would leave
    // a row that this user-scoped delete catches. Added after audit found
    // CourseMentorChatModel was missing from both cleanup paths.
    CourseMentorChatModel.deleteMany({ userId: user._id }),
    UserGamificationModel.deleteMany({ userId: user._id }),
    // Strip these courses from any OTHER user's favorites — `CourseModel.deleteMany`
    // below doesn't trigger the $pull that single-course deletion does.
    UserModel.updateMany(
      { favoriteCourseIds: { $in: courseIds } },
      { $pull: { favoriteCourseIds: { $in: courseIds } } },
    ),
  ]);
  await CourseModel.deleteMany({ userId: user._id });

  // Cancel ALL active Stripe subscriptions on this customer so the user
  // isn't billed next period. We list-and-cancel rather than relying on
  // the single id we cached in DB — historical drift or manual Stripe
  // tinkering can leave stragglers, and one orphan that keeps charging a
  // deleted user is the worst possible regression.
  //
  // Done BEFORE the User row is deleted so the webhook each cancel fires
  // (customer.subscription.deleted) can still find the user by
  // stripeSubscriptionId/stripeCustomerId and apply its state transition.
  // Failure here is logged but does not block deletion — the user's right
  // to erasure takes priority; residual Stripe cleanup falls to admin.
  const customerId = user.subscription?.stripeCustomerId;
  if (customerId) {
    try {
      await cancelAllSubscriptionsForCustomer({ customerId });
    } catch (err) {
      bgError('stripe.cancelOnAccountDelete')(err);
    }
  }

  // Upsert abuse-log BEFORE deleting the ledger, so the lifetime-credits
  // aggregation can still read the soon-to-be-deleted rows. Failure here
  // must not block deletion — the account drop is the user's primary
  // right-to-erasure request. Log + continue on error.
  try {
    await recordAccountDeletion({ email: user.email, userId: user._id });
  } catch (err) {
    bgError('abuseLog.recordAccountDeletion')(err);
  }

  // Drop the credit ledger rows after the abuse-log snapshot is taken.
  // We keep zero post-deletion bookkeeping:
  //   - Lifetime totals needed for future abuse detection live in AbuseLog.
  //   - Financial reconciliation can always be reconstructed from Stripe
  //     (stripeEventId is the authoritative audit trail).
  //   - Under GDPR this is the cleaner answer — no orphan rows hanging
  //     around the system linked to a deleted user.
  await CreditLedgerModel.deleteMany({ userId: user._id })
    .catch(bgError('creditLedger.deleteOnAccountDelete'));

  await UserModel.findByIdAndDelete(userId);

  res.status(200).json({ data: { deleted: true } });
});
