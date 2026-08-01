import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import UserModel from '@models/UserModel';
import MarketingContactModel from '@models/MarketingContactModel';
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
import UsageEventModel from '@models/UsageEventModel';
import SecurityActionTokenModel from '@models/SecurityActionTokenModel';
import SourceDocumentModel from '@models/SourceDocumentModel';
import { cleanupCourseContent, cleanupCourseSources } from '@services/courseCleanupService';
import { deleteSourceChunksForUser } from '@services/sourceDocRagService';
import { deleteByPrefix } from '@services/s3Service';
import { recordAccountDeletion } from '@services/abuseLogService';
import { cancelAllSubscriptionsForCustomer } from '@services/stripeService';
import { consumeSecurityActionCode } from '@services/securityActionService';
import { deletePromotionalContact } from '@services/mailjetContactService';
import { bgError } from '@lib/bg';
import { analytics } from '@lib/analytics';
import { TOPUP_CREDITS_PER_USD } from '@lib/creditPricing';
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
  analytics.track(userId, 'security_action_otp_consumed', { action: 'delete_account' });

  const courseIds = await CourseModel.find({ userId: user._id }).distinct('_id');

  // Snapshot cohort fields BEFORE the cascade — once the user row is gone
  // we can't recover createdAt or the bonus balance for the analytics
  // event. `unspent_topup_value_usd` lets us measure how much "unused"
  // money is forfeited at deletion (a refund-policy/UX signal).
  const tenureMs = user.createdAt instanceof Date ? Date.now() - user.createdAt.getTime() : null;
  const tenureDays = tenureMs !== null ? Math.max(0, Math.floor(tenureMs / (24 * 60 * 60 * 1000))) : undefined;
  const totalCourses = courseIds.length;
  const bonusCredits = user.credits?.bonusBalance ?? 0;
  const unspentTopupValueUsd =
    TOPUP_CREDITS_PER_USD > 0 ? Number((bonusCredits / TOPUP_CREDITS_PER_USD).toFixed(2)) : 0;

  // Run the abuse-log write FIRST (with synchronous retry) so a transient
  // failure can't open a free-credit farming loop: if the cascade ran
  // before this and the abuse-log write later silently failed, the
  // attacker's email would be wiped from `AbuseLog` while the User row +
  // ledger were also gone — a re-signup with the same canonical email
  // would pass the abuse gate and earn the full free grant again. By
  // gating the cascade on a successful abuse-log write, the worst case
  // becomes "user retries deletion later" rather than "attacker farms
  // free credits forever". Idempotent on re-run.
  let abuseLogged = false;
  let lastErr: unknown;
  const backoffsMs = [100, 500, 2_000];
  for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
    try {
      await recordAccountDeletion({ email: user.email, userId: user._id });
      abuseLogged = true;
      break;
    } catch (err) {
      lastErr = err;
      bgError('abuseLog.recordAccountDeletion')(err);
      if (attempt < backoffsMs.length) {
        await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
      }
    }
  }
  if (!abuseLogged) {
    res.status(503);
    throw new Error(
      `Account deletion temporarily unavailable: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  // Delegate per-course cleanup to the same primitives `deleteCourse` uses so
  // the two deletion paths can't drift when new course-scoped models are added.
  // `cleanupCourseContent` covers lesson content, quiz content, chat, progress,
  // recall cards, recall-progress, and S3 assets under `lessons/{courseId}/`;
  // `cleanupCourseSources` covers the course-from-documents corpus
  // (SourceDocument rows, chunk rows + Pinecone vectors via the Mongo
  // manifest, and the `uploads/{userId}/{courseId}/` S3 prefix).
  const userIdStr = user._id.toString();
  await Promise.all(
    courseIds.flatMap((id) => [
      cleanupCourseContent(id.toString()),
      cleanupCourseSources({ courseId: id.toString(), userId: userIdStr }),
    ]),
  );

  await Promise.all([
    JobModel.deleteMany({ userId: user._id }),
    // Course-from-documents FK-drift backstops — the per-course pass above
    // covers rows whose course still exists; these user-scoped wipes catch
    // strays. The chunk backstop goes through the RAG service (Mongo-
    // manifest-first) so any drifted rows take their Pinecone vectors with
    // them instead of orphaning them.
    deleteSourceChunksForUser(userIdStr),
    SourceDocumentModel.deleteMany({ userId: user._id }),
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
    // Per-LLM-call cost telemetry. No TTL on this collection, so without an
    // explicit wipe the rows accumulate indefinitely after the user is gone
    // and become unattributable orphans (no User row to look up). Same
    // GDPR-erasure rationale as CreditLedger: financial reconciliation lives
    // in Stripe; in-app analytics aren't a tax document.
    UsageEventModel.deleteMany({ userId: user._id }),
    // Active 2FA OTP tokens for sensitive actions. The collection has a TTL
    // index that would eventually sweep these, but explicit cleanup keeps
    // the right-to-erasure complete the moment the cascade runs (no live
    // tokens carrying the deleted user's id for the TTL window).
    SecurityActionTokenModel.deleteMany({ userId: user._id }),
    // Strip these courses from any OTHER user's favorites — `CourseModel.deleteMany`
    // below doesn't trigger the $pull that single-course deletion does.
    UserModel.updateMany(
      { favoriteCourseIds: { $in: courseIds } },
      { $pull: { favoriteCourseIds: { $in: courseIds } } },
    ),
  ]);
  await CourseModel.deleteMany({ userId: user._id });

  // Wipe the user's WHOLE upload prefix — belt over the per-course wipes
  // above, and the only cover for uploads whose course row already drifted
  // away. Awaited-but-tolerant: an S3 blip must not block the user's right
  // to erasure on our primary stores; the failure is loud for ops retry.
  //
  // Deliberately NOT deleted (declared REPORT-Act exception, data-protection
  // §4.2): ContentFlag rows and their `quarantine/` S3 objects — CSAM
  // hash-match evidence must be preserved for 1 year (18 U.S.C. §2258A;
  // the rows TTL out via `retentionUntil`, quarantine cleanup is manual per
  // the L1 runbook). `quarantine/` sits outside `uploads/` by design, so
  // this prefix wipe structurally cannot touch it.
  try {
    await deleteByPrefix(`uploads/${userIdStr}/`);
  } catch (err) {
    bgError('s3.deleteUploadsOnAccountDelete')(err);
  }

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

  // Marketing ledger erasure (F13). Without this the deleted user's email
  // survives inside the send audience — they would keep receiving campaigns
  // after asking us to erase them, which is the exact opposite of what the
  // cascade promises.
  //
  // Matched on userId OR email: rows seeded from the existing user base
  // carry the link, but a row written before the link existed (or after a
  // re-signup) is only findable by address. Runs BEFORE the User row drop
  // so `user.email` is still readable.
  try {
    await MarketingContactModel.deleteMany({
      $or: [{ userId: user._id }, { email: user.email }],
    });
  } catch (err) {
    bgError('marketingContact.deleteOnAccountDelete')(err);
  }

  // Per-campaign send log. The model is Phase 4's and does not exist yet, so
  // this goes through the driver rather than a Mongoose model: a
  // `deleteMany` against an absent collection is a no-op, and this way the
  // cascade covers the rows the moment that collection appears instead of
  // waiting for someone to remember to come back here.
  try {
    await mongoose.connection.db?.collection('MarketingSend').deleteMany({ email: user.email });
  } catch (err) {
    bgError('marketingSend.deleteOnAccountDelete')(err);
  }

  // GDPR right-to-erasure on the marketing sub-processor. Done BEFORE the
  // User row drop so the email is still in scope (Mailjet is keyed on the
  // email, not on our internal user id). Failure must not block deletion —
  // the user's right-to-erasure on OUR systems is non-negotiable; residual
  // Mailjet cleanup falls to the operator on alarm.
  try {
    await deletePromotionalContact(user.email);
  } catch (err) {
    bgError('mailjet.deleteContactOnAccountDelete')(err);
  }

  // Drop the credit ledger rows after the abuse-log snapshot is taken
  // (above, before the cascade). The lifetime-credits aggregation that
  // `recordAccountDeletion` performs reads CreditLedger rows; running
  // ledger-delete after the abuse-log write keeps that read intact.
  // We keep zero post-deletion bookkeeping:
  //   - Lifetime totals needed for future abuse detection live in AbuseLog.
  //   - Financial reconciliation can always be reconstructed from Stripe
  //     (stripeEventId is the authoritative audit trail).
  //   - Under GDPR this is the cleaner answer — no orphan rows hanging
  //     around the system linked to a deleted user.
  await CreditLedgerModel.deleteMany({ userId: user._id })
    .catch(bgError('creditLedger.deleteOnAccountDelete'));

  await UserModel.findByIdAndDelete(userId);

  // Fire `account_deleted` THEN `deleteUser` (GDPR right-to-erasure).
  // Order matters: the event needs the user's profile to exist when it
  // lands so cohort membership is captured; immediately after, the
  // delete request strips the profile + every prior event from Mixpanel.
  analytics.track(userId, 'account_deleted', {
    ...(tenureDays !== undefined && { tenure_days: tenureDays }),
    total_courses: totalCourses,
    unspent_topup_value_usd: unspentTopupValueUsd,
  });
  analytics.deleteUser(userId);

  res.status(200).json({ data: { deleted: true } });
});
