import asyncHandler from 'express-async-handler';
import UserModel, { AuthProvider } from '@models/UserModel';
import CourseModel from '@models/CourseModel';
import CreditLedgerModel from '@models/CreditLedgerModel';
import JobModel from '@models/JobModel';
import CourseDesignChatModel from '@models/CourseDesignChatModel';
import LessonMentorChatModel from '@models/LessonMentorChatModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import UserInsightProgressModel from '@models/UserInsightProgressModel';
import UserGamificationModel from '@models/UserGamificationModel';
import { cleanupCourseContent } from '@services/courseCleanupService';
import { recordAccountDeletion } from '@services/abuseLogService';
import { cancelAllSubscriptionsForCustomer } from '@services/stripeService';
import { bgError } from '@lib/bg';
import { deleteAccountSchema } from './validation';

/**
 * @swagger
 * /api/auth/delete-account:
 *   delete:
 *     summary: Delete the authenticated user's account and all associated data
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
 *             required: [password]
 *             properties:
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
 *                   required: [deleted]
 *                   properties:
 *                     deleted:
 *                       type: boolean
 *       401:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const deleteAccountController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const user = await UserModel.findById(userId).select('+password');

  if (!user) {
    res.status(401);
    throw new Error('Not authenticated');
  }

  // Require password confirmation for users with credentials auth
  const hasCredentials = user.authProviders.some((p) => p.provider === AuthProvider.CREDENTIALS);

  if (hasCredentials) {
    const { password } = deleteAccountSchema.parse(req.body);
    const isValid = await user.comparePassword(password);

    if (!isValid) {
      res.status(401);
      throw new Error('Invalid password');
    }
  }

  const courseIds = await CourseModel.find({ userId: user._id }).distinct('_id');

  // Delegate per-course cleanup to the same primitive `deleteCourse` uses so
  // the two deletion paths can't drift when new course-scoped models are added.
  // Covers lesson content, quiz content, chat, progress, insights,
  // insight-progress, and S3 assets under `lessons/{courseId}/`.
  await Promise.all(courseIds.map((id) => cleanupCourseContent(id.toString())));

  await Promise.all([
    JobModel.deleteMany({ userId: user._id }),
    UserLessonProgressModel.deleteMany({ userId: user._id }),
    UserModuleQuizProgressModel.deleteMany({ userId: user._id }),
    UserInsightProgressModel.deleteMany({ userId: user._id }),
    CourseDesignChatModel.deleteMany({ userId: user._id }),
    // Defense-in-depth user-scoped wipe — `cleanupCourseContent` above
    // already handles mentor chats per owned course, but a stray row left
    // by a foreign-key drift would persist indefinitely without this.
    // Mirrors the `CourseDesignChatModel` pattern.
    LessonMentorChatModel.deleteMany({ userId: user._id }),
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

  console.log(`[API] Account deleted: ${userId}`.green);

  res.status(200).json({ data: { deleted: true } });
});
