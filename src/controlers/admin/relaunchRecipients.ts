import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import RelaunchRecipientModel from '@models/RelaunchRecipientModel';
import SignupCreditGrantModel from '@models/SignupCreditGrantModel';
import UserModel from '@models/UserModel';
import { sendOldUserRelaunchEmail, sendOldPayingUserThanksEmail } from '@services/emailService';
import { integrationLog } from '@lib/loggers';
import mongoose from 'mongoose';

// Operator surfaces for the old-user relaunch campaign:
//   - GET   /api/admin/relaunch/recipients         → list send roster
//   - POST  /api/admin/relaunch/send               → send a batch
//   - PATCH /api/admin/relaunch/recipients/grant   → adjust grant per email
//
// Send is intentionally synchronous + sequential: the operator drives the
// batch size from the UI (e.g. 50 at a time), so warm-up and sender
// reputation stay in their control. Throughput is not the goal here.

const PAGE_LIMIT_MAX = 500;

const listQuerySchema = z.object({
  status: z.enum(['all', 'pending', 'sent']).default('all'),
  paying: z.enum(['any', 'only', 'exclude']).default('any'),
  // Free-text substring match against email — case-insensitive.
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// Escape characters that have special meaning in a JS regex so a user-typed
// "a+b" doesn't blow up the query. The match is anchored by /i flag only —
// any substring of the email field hits.
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @swagger
 * /api/admin/relaunch/recipients:
 *   get:
 *     summary: List old-user relaunch recipients (admin-only)
 *     description: |
 *       Returns rows from `RelaunchRecipient` with their `sentAt` state, plus
 *       the matching `SignupCreditGrant.usdAmount` if a grant exists for that
 *       email. Used by the admin UI to render the send list and disable the
 *       per-row "send" button once `sentAt` is populated. Supports a free-text
 *       email substring filter and a paying-user filter.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [all, pending, sent]
 *           default: all
 *       - in: query
 *         name: paying
 *         schema:
 *           type: string
 *           enum: [any, only, exclude]
 *           default: any
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *           maxLength: 200
 *         description: Case-insensitive email substring match.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 500
 *           default: 100
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
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
 *                   required: [recipients, total, pendingCount, sentCount, payingCount, signedUpCount]
 *                   properties:
 *                     recipients:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [email, sent, wasPayingUser, signedUp]
 *                         properties:
 *                           email:
 *                             type: string
 *                             format: email
 *                           sent:
 *                             type: boolean
 *                           sentAt:
 *                             type: string
 *                             format: date-time
 *                             nullable: true
 *                           wasPayingUser:
 *                             type: boolean
 *                           signedUp:
 *                             type: boolean
 *                           signedUpAt:
 *                             type: string
 *                             format: date-time
 *                             nullable: true
 *                           grantUsd:
 *                             type: number
 *                             nullable: true
 *                           grantConsumed:
 *                             type: boolean
 *                             nullable: true
 *                     total:
 *                       type: integer
 *                     pendingCount:
 *                       type: integer
 *                     sentCount:
 *                       type: integer
 *                     payingCount:
 *                       type: integer
 *                     signedUpCount:
 *                       type: integer
 */
export const listRelaunchRecipientsController = asyncHandler(async (req, res) => {
  const { status, paying, q, limit, offset } = listQuerySchema.parse(req.query);

  const filter: Record<string, unknown> = {};
  if (status === 'pending') filter.sentAt = { $exists: false };
  if (status === 'sent') filter.sentAt = { $exists: true };
  if (paying === 'only') filter.wasPayingUser = true;
  if (paying === 'exclude') filter.wasPayingUser = { $ne: true };
  if (q && q.length > 0) filter.email = { $regex: escapeRegex(q.toLowerCase()), $options: 'i' };

  // `signedUpCount` is the count of recipients whose email also has a User
  // row. Computed via aggregation so we don't pull thousands of User docs
  // back into Node just to count them. The match on the second stage uses
  // the same `filter` as the recipient list — the count reflects the
  // currently visible slice (status / paying / search), which is what the
  // operator usually wants to see next to the other top-row stats.
  const signedUpCountPromise = RelaunchRecipientModel.aggregate<{ n: number }>([
    { $match: filter },
    {
      $lookup: {
        from: 'User',
        localField: 'email',
        foreignField: 'email',
        as: 'user',
        pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }],
      },
    },
    { $match: { 'user.0': { $exists: true } } },
    { $count: 'n' },
  ]).then((arr) => arr[0]?.n ?? 0);

  const [rows, total, pendingCount, sentCount, payingCount, signedUpCount] = await Promise.all([
    RelaunchRecipientModel.find(filter)
      .sort({ sentAt: 1, email: 1 })
      .skip(offset)
      .limit(limit)
      .lean(),
    RelaunchRecipientModel.countDocuments(filter),
    RelaunchRecipientModel.countDocuments({ sentAt: { $exists: false } }),
    RelaunchRecipientModel.countDocuments({ sentAt: { $exists: true } }),
    RelaunchRecipientModel.countDocuments({ wasPayingUser: true }),
    signedUpCountPromise,
  ]);

  // Inline-join grants AND users on the email list (avoids per-row find
  // loops). With at most `limit` emails each fits a single `$in` query
  // comfortably.
  const emails = rows.map((r) => r.email);
  const [grants, users] = await Promise.all([
    SignupCreditGrantModel.find({ email: { $in: emails } })
      .select('email usdAmount consumedAt')
      .lean(),
    UserModel.find({ email: { $in: emails } }).select('email createdAt').lean(),
  ]);
  const grantByEmail = new Map(grants.map((g) => [g.email, g] as const));
  const userByEmail = new Map(users.map((u) => [u.email, u] as const));

  res.status(200).json({
    data: {
      recipients: rows.map((r) => {
        const grant = grantByEmail.get(r.email);
        const user = userByEmail.get(r.email);
        return {
          email: r.email,
          sent: Boolean(r.sentAt),
          sentAt: r.sentAt ? r.sentAt.toISOString() : null,
          wasPayingUser: Boolean(r.wasPayingUser),
          signedUp: Boolean(user),
          signedUpAt: user?.createdAt ? user.createdAt.toISOString() : null,
          grantUsd: grant ? grant.usdAmount : null,
          grantConsumed: grant ? Boolean(grant.consumedAt) : null,
        };
      }),
      total,
      pendingCount,
      sentCount,
      payingCount,
      signedUpCount,
    },
  });
});

const sendBatchSchema = z.object({
  // Cap matches Mailjet's burst-safe practical batch — anything bigger and a
  // single bad address in the middle stalls a UX-noticeable amount of work.
  emails: z.array(z.string().email()).min(1).max(100),
});

/**
 * @swagger
 * /api/admin/relaunch/send:
 *   post:
 *     summary: Send the relaunch email to a batch of recipients (admin-only)
 *     description: |
 *       Sends synchronously to each address in `emails`, in order. The
 *       template is chosen per-recipient from the recipient row's
 *       `wasPayingUser` flag — paying users get the founder-voiced
 *       thanks/apology template, everyone else gets the standard relaunch.
 *       This keeps the operator from accidentally sending the wrong copy
 *       to a paying user.
 *
 *       Per-address contract: only sends if the recipient row exists and
 *       `sentAt` is unset (re-clicking "send" never double-mails). Flips
 *       `sentAt` to now on success.
 *
 *       Returns a per-address outcome (including which template shipped)
 *       the UI uses to update its row state. Throughput is intentionally
 *       low — the operator drives batch size from the admin tab. Warm the
 *       sender (start small, watch bounce/spam in Mailjet) before scaling.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [emails]
 *             properties:
 *               emails:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 100
 *                 items:
 *                   type: string
 *                   format: email
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
 *                   required: [results, sentCount, skippedCount, failedCount]
 *                   properties:
 *                     results:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [email, status]
 *                         properties:
 *                           email:
 *                             type: string
 *                             format: email
 *                           status:
 *                             type: string
 *                             enum: [sent, already_sent, not_in_list, failed]
 *                           template:
 *                             type: string
 *                             enum: [old_user_relaunch, old_paying_user_thanks]
 *                             nullable: true
 *                           error:
 *                             type: string
 *                             nullable: true
 *                     sentCount:
 *                       type: integer
 *                     skippedCount:
 *                       type: integer
 *                     failedCount:
 *                       type: integer
 */
export const sendRelaunchBatchController = asyncHandler(async (req, res) => {
  const { emails } = sendBatchSchema.parse(req.body);
  const adminId = req.userId;

  type TemplateKey = 'old_user_relaunch' | 'old_paying_user_thanks';
  type Result = {
    email: string;
    status: 'sent' | 'already_sent' | 'not_in_list' | 'failed';
    template?: TemplateKey;
    error?: string;
  };
  const results: Result[] = [];

  for (const rawEmail of emails) {
    const email = rawEmail.toLowerCase().trim();
    try {
      // CAS: only sends if recipient row exists AND `sentAt` is unset. Atomic
      // wrt concurrent "send" clicks from a second admin tab. We send AFTER
      // claiming so a Mailjet failure rolls back the claim — otherwise a
      // transient send failure would lock the row forever.
      const claimed = await RelaunchRecipientModel.findOneAndUpdate(
        { email, sentAt: { $exists: false } },
        {
          $set: {
            sentAt: new Date(),
            sentByUserId: adminId ? new mongoose.Types.ObjectId(adminId) : undefined,
          },
        },
        { returnDocument: 'after' },
      );

      if (!claimed) {
        // Either no row at all, or already sent. Distinguish for the UI.
        const exists = await RelaunchRecipientModel.exists({ email });
        results.push({ email, status: exists ? 'already_sent' : 'not_in_list' });
        continue;
      }

      // Auto-route on the recipient's `wasPayingUser` flag — the row is the
      // source of truth; the operator cannot accidentally send standard
      // copy to a paying user.
      const template: TemplateKey = claimed.wasPayingUser
        ? 'old_paying_user_thanks'
        : 'old_user_relaunch';
      const sender =
        template === 'old_paying_user_thanks'
          ? sendOldPayingUserThanksEmail
          : sendOldUserRelaunchEmail;

      try {
        await sender({ to: email });
        results.push({ email, status: 'sent', template });
        integrationLog.info(
          `admin:relaunch:send ok template=${template} to=${email} by=${adminId}`,
        );
      } catch (err) {
        // Roll back the claim so the operator can retry. The send didn't land
        // — leaving `sentAt` set would silently drop the recipient.
        await RelaunchRecipientModel.updateOne(
          { email },
          { $unset: { sentAt: '', sentByUserId: '' } },
        );
        const message = err instanceof Error ? err.message : 'unknown';
        results.push({ email, status: 'failed', template, error: message });
        integrationLog.warn(
          `admin:relaunch:send fail template=${template} to=${email} reason=${message}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      results.push({ email, status: 'failed', error: message });
    }
  }

  const sentCount = results.filter((r) => r.status === 'sent').length;
  const skippedCount = results.filter((r) => r.status === 'already_sent' || r.status === 'not_in_list').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;

  res.status(200).json({
    data: { results, sentCount, skippedCount, failedCount },
  });
});

const updateGrantSchema = z.object({
  email: z.string().email(),
  // Cap at a deliberately generous-but-not-silly number. The operator can
  // still wipe a grant by setting it to 0.
  usdAmount: z.number().min(0).max(1000),
});

/**
 * @swagger
 * /api/admin/relaunch/recipients/grant:
 *   patch:
 *     summary: Update signup grant amount for a relaunch recipient (admin-only)
 *     description: |
 *       Upserts the `SignupCreditGrant` row for `email` with the given
 *       `usdAmount`. Refuses to modify a grant that has already been claimed
 *       — once `consumedAt` is set the user has been awarded the credit and
 *       editing the dollar amount post-hoc would only confuse the audit
 *       trail.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, usdAmount]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               usdAmount:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1000
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
 *                   required: [email, usdAmount, consumed]
 *                   properties:
 *                     email:
 *                       type: string
 *                       format: email
 *                     usdAmount:
 *                       type: number
 *                     consumed:
 *                       type: boolean
 *       409:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const updateRelaunchRecipientGrantController = asyncHandler(async (req, res) => {
  const { email: rawEmail, usdAmount } = updateGrantSchema.parse(req.body);
  const email = rawEmail.toLowerCase().trim();

  // Refuse to mutate an already-claimed grant — the credit's already been
  // awarded; changing the dollar amount here would desync from the
  // CreditLedger row produced at award time.
  const existing = await SignupCreditGrantModel.findOne({ email }).lean();
  if (existing?.consumedAt) {
    res.status(409);
    throw new Error('Grant has already been claimed and cannot be edited');
  }

  const updated = await SignupCreditGrantModel.findOneAndUpdate(
    { email },
    {
      $set: { usdAmount },
      $setOnInsert: { email, reason: 'admin-edit' },
    },
    { upsert: true, returnDocument: 'after' },
  );

  integrationLog.info(
    `admin:relaunch:grant ok email=${email} usd=$${usdAmount} by=${req.userId}`,
  );

  res.status(200).json({
    data: {
      email,
      usdAmount: updated?.usdAmount ?? usdAmount,
      consumed: Boolean(updated?.consumedAt),
    },
  });
});

const addRecipientSchema = z.object({
  email: z.string().email(),
  // Optional starter grant in USD. Omit to skip grant creation entirely.
  usdAmount: z.number().min(0).max(1000).optional(),
  wasPayingUser: z.boolean().optional(),
});

/**
 * @swagger
 * /api/admin/relaunch/recipients:
 *   post:
 *     summary: Add a single recipient to the relaunch roster (admin-only)
 *     description: |
 *       Upserts a `RelaunchRecipient` row for `email`. Optionally seeds a
 *       `SignupCreditGrant` row with the given `usdAmount` (only if the
 *       email doesn't already have an unconsumed grant — existing claimed
 *       grants are left alone). Idempotent: re-posting the same address is
 *       a no-op on the recipient, and the grant update respects the
 *       already-claimed guard.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
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
 *               usdAmount:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1000
 *               wasPayingUser:
 *                 type: boolean
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
 *                   required: [email, wasPayingUser, created]
 *                   properties:
 *                     email:
 *                       type: string
 *                       format: email
 *                     wasPayingUser:
 *                       type: boolean
 *                     grantUsd:
 *                       type: number
 *                       nullable: true
 *                     created:
 *                       type: boolean
 */
export const addRelaunchRecipientController = asyncHandler(async (req, res) => {
  const parsed = addRecipientSchema.parse(req.body);
  const email = parsed.email.toLowerCase().trim();

  const recipientRes = await RelaunchRecipientModel.findOneAndUpdate(
    { email },
    {
      $setOnInsert: { email, importSource: 'admin-ui' },
      ...(parsed.wasPayingUser !== undefined
        ? { $set: { wasPayingUser: parsed.wasPayingUser } }
        : {}),
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: true },
  );

  const recipientDoc = recipientRes?.value ?? null;
  const created = Boolean(recipientRes?.lastErrorObject?.upserted);

  let grantUsd: number | null = null;
  if (parsed.usdAmount !== undefined) {
    // Only touch unclaimed grants. If one already exists & is claimed, we
    // leave it alone and surface the existing amount to the UI.
    const existing = await SignupCreditGrantModel.findOne({ email }).lean();
    if (existing?.consumedAt) {
      grantUsd = existing.usdAmount;
    } else {
      const updatedGrant = await SignupCreditGrantModel.findOneAndUpdate(
        { email },
        {
          $set: { usdAmount: parsed.usdAmount },
          $setOnInsert: { email, importSource: 'admin-ui', reason: 'admin-add' },
        },
        { upsert: true, returnDocument: 'after' },
      );
      grantUsd = updatedGrant?.usdAmount ?? parsed.usdAmount;
    }
  } else {
    const existingGrant = await SignupCreditGrantModel.findOne({ email })
      .select('usdAmount')
      .lean();
    if (existingGrant) grantUsd = existingGrant.usdAmount;
  }

  integrationLog.info(
    `admin:relaunch:add ok email=${email} created=${created} usd=${grantUsd ?? '-'} paying=${parsed.wasPayingUser ?? '-'} by=${req.userId}`,
  );

  res.status(200).json({
    data: {
      email,
      wasPayingUser: Boolean(recipientDoc?.wasPayingUser),
      grantUsd,
      created,
    },
  });
});

const deleteRecipientSchema = z.object({
  email: z.string().email(),
});

/**
 * @swagger
 * /api/admin/relaunch/recipients:
 *   delete:
 *     summary: Remove a relaunch recipient (admin-only)
 *     description: |
 *       Deletes the `RelaunchRecipient` row for `email`. Also deletes the
 *       matching `SignupCreditGrant` row IF it has not yet been claimed —
 *       a consumed grant is left in place because the credit has already
 *       been applied to a User and the row is the audit trail tying that
 *       award back to the relaunch campaign. Idempotent: deleting an
 *       address that doesn't exist returns 200 with `deleted: false`.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *           format: email
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
 *                   required: [email, deleted, grantDeleted]
 *                   properties:
 *                     email:
 *                       type: string
 *                       format: email
 *                     deleted:
 *                       type: boolean
 *                     grantDeleted:
 *                       type: boolean
 *                     grantPreservedConsumed:
 *                       type: boolean
 */
export const deleteRelaunchRecipientController = asyncHandler(async (req, res) => {
  const { email: rawEmail } = deleteRecipientSchema.parse(req.query);
  const email = rawEmail.toLowerCase().trim();

  const recipientRes = await RelaunchRecipientModel.deleteOne({ email });

  // Preserve a consumed grant as the audit row for the awarded credit. Only
  // delete the grant if it's still unclaimed.
  const grant = await SignupCreditGrantModel.findOne({ email }).select('consumedAt').lean();
  let grantDeleted = false;
  let grantPreservedConsumed = false;
  if (grant) {
    if (grant.consumedAt) {
      grantPreservedConsumed = true;
    } else {
      const grantRes = await SignupCreditGrantModel.deleteOne({ email, consumedAt: { $exists: false } });
      grantDeleted = grantRes.deletedCount > 0;
    }
  }

  integrationLog.info(
    `admin:relaunch:delete email=${email} recipient=${recipientRes.deletedCount > 0} grant=${grantDeleted} grantConsumed=${grantPreservedConsumed} by=${req.userId}`,
  );

  res.status(200).json({
    data: {
      email,
      deleted: recipientRes.deletedCount > 0,
      grantDeleted,
      grantPreservedConsumed,
    },
  });
});

const updatePayingSchema = z.object({
  email: z.string().email(),
  wasPayingUser: z.boolean(),
});

/**
 * @swagger
 * /api/admin/relaunch/recipients/paying:
 *   patch:
 *     summary: Toggle the wasPayingUser flag on a relaunch recipient (admin-only)
 *     description: |
 *       Flips `wasPayingUser` on the recipient row so the operator can mark
 *       users from the UI without re-running the import script.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, wasPayingUser]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               wasPayingUser:
 *                 type: boolean
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
 *                   required: [email, wasPayingUser]
 *                   properties:
 *                     email:
 *                       type: string
 *                       format: email
 *                     wasPayingUser:
 *                       type: boolean
 *       404:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const updateRelaunchRecipientPayingController = asyncHandler(async (req, res) => {
  const { email: rawEmail, wasPayingUser } = updatePayingSchema.parse(req.body);
  const email = rawEmail.toLowerCase().trim();

  const updated = await RelaunchRecipientModel.findOneAndUpdate(
    { email },
    { $set: { wasPayingUser } },
    { returnDocument: 'after' },
  );

  if (!updated) {
    res.status(404);
    throw new Error('Recipient not found');
  }

  res.status(200).json({
    data: { email, wasPayingUser: Boolean(updated.wasPayingUser) },
  });
});
