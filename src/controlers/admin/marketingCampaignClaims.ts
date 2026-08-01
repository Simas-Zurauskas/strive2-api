import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import { MARKETING_CAMPAIGNS } from '@lib/constants';
import MarketingContactModel, {
  PROMOTIONAL_AUDIENCE_FILTER,
} from '@models/MarketingContactModel';
import MarketingSendModel from '@models/MarketingSendModel';
import { STRANDED_CLAIM_AFTER_MS } from './sendMarketingCampaign';
import { integrationLog } from '@lib/loggers';

// Visibility and recovery for claims a hard kill left behind (F11).
//
// The send path claims a recipient BEFORE calling Mailjet, so a process
// killed in the gap — a deploy, an OOM, an operator closing the tab on a
// long batch — leaves a row with `claimedAt` set and `sentAt` never written.
// That row's address is permanently unclaimable: the CAS filter requires
// `claimedAt` to be absent, so every later batch reports `already_sent` for
// someone who was never sent anything.
//
// Without these two endpoints the only way out is a hand-written Mongo
// update against production, which is why the plan called the admin panel
// row mandatory rather than nice-to-have. The GET makes stranded claims
// visible; the POST frees them so the normal batch path retries.
//
// The GET doubles as the campaign's progress read — the panel needs the
// audience count and the sent/failed totals in the same paint, and splitting
// them across two endpoints would only give the operator two numbers taken
// at two different moments.

const querySchema = z.object({
  campaignKey: z.enum(MARKETING_CAMPAIGNS),
});

const reclaimSchema = z.object({
  campaignKey: z.enum(MARKETING_CAMPAIGNS),
  /** Restrict the reclaim to specific addresses. Omitted, every stranded
   *  claim on the campaign is freed. */
  emails: z.array(z.string().email()).min(1).max(500).optional(),
});

/** A claim is only stranded once it is older than the send path could
 *  plausibly still be working on. Anything younger may be a batch in flight
 *  in another tab, and reclaiming that would hand the same recipient to two
 *  senders. */
const strandedFilter = (campaignKey: string) => ({
  campaignKey,
  status: 'claiming' as const,
  claimedAt: { $lt: new Date(Date.now() - STRANDED_CLAIM_AFTER_MS) },
});

/**
 * @swagger
 * /api/admin/marketing/claims:
 *   get:
 *     summary: Campaign progress and stranded send claims (admin-only)
 *     description: |
 *       Returns the campaign's audience and progress counts, plus any send
 *       claims left behind by a process that died between claiming a
 *       recipient and delivering to them. A stranded claim blocks that
 *       address from every later batch until it is released via the reclaim
 *       endpoint.
 *
 *       Claims younger than the strand threshold are not reported — they may
 *       belong to a batch still running.
 *
 *       Gated by `protect → requireVerified → requireAdmin`.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: campaignKey
 *         required: true
 *         schema:
 *           type: string
 *           enum: [documents-feature-2026-08]
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
 *                   required: [campaignKey, audienceCount, sentCount, failedCount, hardBouncedCount, remainingCount, strandedClaims]
 *                   properties:
 *                     campaignKey:
 *                       type: string
 *                       enum: [documents-feature-2026-08]
 *                     audienceCount:
 *                       type: integer
 *                       description: Marketing contacts eligible for promotional email.
 *                     sentCount:
 *                       type: integer
 *                     failedCount:
 *                       type: integer
 *                       description: Rolled-back attempts awaiting a retry.
 *                     hardBouncedCount:
 *                       type: integer
 *                     remainingCount:
 *                       type: integer
 *                       description: Eligible contacts with no delivered or in-flight send row.
 *                     strandedClaims:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [email, claimedAt, attempts]
 *                         properties:
 *                           email:
 *                             type: string
 *                             format: email
 *                           claimedAt:
 *                             type: string
 *                             format: date-time
 *                           attempts:
 *                             type: integer
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
 *       403:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const listMarketingCampaignClaimsController = asyncHandler(async (req, res) => {
  const { campaignKey } = querySchema.parse(req.query);

  const [audienceCount, sentCount, failedCount, hardBouncedCount, handledCount, stranded] =
    await Promise.all([
      MarketingContactModel.countDocuments(PROMOTIONAL_AUDIENCE_FILTER),
      MarketingSendModel.countDocuments({ campaignKey, status: 'sent' }),
      MarketingSendModel.countDocuments({ campaignKey, status: 'failed' }),
      MarketingSendModel.countDocuments({ campaignKey, status: 'hard_bounced' }),
      MarketingSendModel.countDocuments({
        campaignKey,
        status: { $in: ['claiming', 'sent', 'hard_bounced'] },
      }),
      MarketingSendModel.find(strandedFilter(campaignKey))
        .select('email claimedAt attempts')
        .sort({ claimedAt: 1 })
        .limit(500)
        .lean<{ email: string; claimedAt: Date; attempts: number }[]>(),
    ]);

  res.status(200).json({
    data: {
      campaignKey,
      audienceCount,
      sentCount,
      failedCount,
      hardBouncedCount,
      remainingCount: Math.max(0, audienceCount - handledCount),
      strandedClaims: stranded.map((row) => ({
        email: row.email,
        claimedAt: row.claimedAt.toISOString(),
        attempts: row.attempts,
      })),
    },
  });
});

/**
 * @swagger
 * /api/admin/marketing/reclaim:
 *   post:
 *     summary: Release stranded send claims so they can be retried (admin-only)
 *     description: |
 *       Clears the claim on send rows left in flight by a process that died
 *       before delivering, returning them to the pool the next batch draws
 *       from. Only claims older than the strand threshold are affected, so a
 *       batch running in another session cannot have its recipients taken.
 *
 *       Rows that were actually delivered are untouched — the operation
 *       matches on the in-flight status only, so it can never resurrect a
 *       completed send into a second delivery.
 *
 *       Gated by `protect → requireVerified → requireAdmin`.
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
 *             additionalProperties: false
 *             required: [campaignKey]
 *             properties:
 *               campaignKey:
 *                 type: string
 *                 enum: [documents-feature-2026-08]
 *               emails:
 *                 type: array
 *                 maxItems: 500
 *                 items:
 *                   type: string
 *                   format: email
 *                 description: Restrict the reclaim to these addresses. Omitted, all stranded claims are released.
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
 *                   required: [reclaimedCount]
 *                   properties:
 *                     reclaimedCount:
 *                       type: integer
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
 *       403:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const reclaimMarketingCampaignClaimsController = asyncHandler(async (req, res) => {
  const { campaignKey, emails } = reclaimSchema.parse(req.body);

  const filter = {
    ...strandedFilter(campaignKey),
    ...(emails ? { email: { $in: emails.map((e) => e.toLowerCase().trim()) } } : {}),
  };

  // Status guard, not just an id match: `status: 'claiming'` is part of
  // `strandedFilter`, so a row that reached `sent` between the operator's
  // read and this write matches nothing and stays sent.
  const result = await MarketingSendModel.updateMany(filter, {
    $unset: { claimedAt: '' },
    $set: { status: 'failed', lastError: 'claim released by operator (stranded)' },
  });

  if (result.modifiedCount === 0) {
    // Not an error — the operator may simply have been looking at a stale
    // panel — but worth distinguishing from a successful release.
    integrationLog.info(`admin:marketing:reclaim none campaign=${campaignKey}`);
  } else {
    integrationLog.info(
      `admin:marketing:reclaim ok campaign=${campaignKey} count=${result.modifiedCount} by=${req.userId}`,
    );
  }

  res.status(200).json({ data: { reclaimedCount: result.modifiedCount } });
});

/** Exported for the campaign tests; not a route. */
export const __strandedFilter = strandedFilter;
