import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import UsageEventModel from '@models/UsageEventModel';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { MICROCENTS_PER_CREDIT } from '@lib/creditPricing';
import { attributeEvent } from '@lib/billingAttribution';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const SORTABLE_FIELDS = ['timestamp', 'costMicroCents', 'chargedMicroCents', 'service'] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];

const parsePositiveInt = ({ value, fallback, cap }: { value: unknown; fallback: number; cap?: number }): number => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  const intN = Math.floor(n);
  return cap !== undefined ? Math.min(intN, cap) : intN;
};

const parseSortBy = (value: unknown): SortableField => {
  if (typeof value !== 'string') return 'timestamp';
  return (SORTABLE_FIELDS as readonly string[]).includes(value)
    ? (value as SortableField)
    : 'timestamp';
};

const parseSortDir = (value: unknown): 1 | -1 => {
  if (value === 'asc' || value === '1' || value === 1) return 1;
  return -1;
};

/**
 * @swagger
 * /api/usage/history:
 *   get:
 *     summary: Paginated list of the caller's paid-action events, newest first
 *     tags:
 *       - Usage
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *       - in: query
 *         name: sortBy
 *         schema:
 *           $ref: '#/components/schemas/UsageSortField'
 *       - in: query
 *         name: sortDir
 *         schema:
 *           $ref: '#/components/schemas/UsageSortDir'
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/UsageHistory'
 */
export const getUsageHistoryController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const limit = Math.max(1, parsePositiveInt({ value: req.query.limit, fallback: DEFAULT_LIMIT, cap: MAX_LIMIT }));
  const offset = parsePositiveInt({ value: req.query.offset, fallback: 0 });
  const sortBy = parseSortBy(req.query.sortBy);
  const sortDir = parseSortDir(req.query.sortDir);

  const userObjId = new mongoose.Types.ObjectId(userId);

  const [rows, total] = await Promise.all([
    UsageEventModel.find({ userId: userObjId })
      .sort({ [sortBy]: sortDir })
      .skip(offset)
      .limit(limit)
      .lean(),
    UsageEventModel.countDocuments({ userId: userObjId }),
  ]);

  // Distinct jobIds present on this page. Used to fetch the matching
  // debit_action ledger rows (one per job) and the per-job total chargedMicroCents
  // — both needed to pro-rate the user-paid USD onto each event.
  const jobIdStrings = Array.from(
    new Set(
      rows
        .map((r) => (r.metadata as Record<string, unknown> | undefined)?.jobId)
        .filter((v): v is string => typeof v === 'string'),
    ),
  );
  const jobObjIds = jobIdStrings
    .filter((s) => mongoose.Types.ObjectId.isValid(s))
    .map((s) => new mongoose.Types.ObjectId(s));

  const [ledgerRows, jobTotals] = jobObjIds.length === 0
    ? [[], [] as { _id: string; total: number }[]]
    : await Promise.all([
        CreditLedgerModel.find({
          userId: userObjId,
          reason: 'debit_action',
          jobId: { $in: jobObjIds },
        }).lean(),
        // Group by metadata.jobId (string) and sum chargedMicroCents (fall back
        // to costMicroCents for legacy rows lacking the markup field).
        UsageEventModel.aggregate<{ _id: string; total: number }>([
          { $match: { userId: userObjId, 'metadata.jobId': { $in: jobIdStrings } } },
          {
            $group: {
              _id: '$metadata.jobId',
              total: { $sum: { $ifNull: ['$chargedMicroCents', '$costMicroCents'] } },
            },
          },
        ]),
      ]);

  const ledgerByJobId = new Map(
    ledgerRows.map((row) => [row.jobId?.toString() ?? '', row]),
  );
  const totalByJobId = new Map(jobTotals.map((row) => [row._id, row.total]));

  res.status(200).json({
    data: {
      events: rows.map((r) => {
        const eventCharged = r.chargedMicroCents ?? r.costMicroCents;
        const jobId = (r.metadata as Record<string, unknown> | undefined)?.jobId;
        const jobIdStr = typeof jobId === 'string' ? jobId : null;
        const ledger = jobIdStr ? ledgerByJobId.get(jobIdStr) : undefined;
        const jobTotal = jobIdStr ? totalByJobId.get(jobIdStr) ?? 0 : 0;
        const attribution = attributeEvent({
          eventChargedMicroCents: eventCharged,
          jobTotalChargedMicroCents: jobTotal,
          ledger: ledger
            ? { allowanceDelta: ledger.allowanceDelta, bonusDelta: ledger.bonusDelta }
            : null,
          planAtTime: r.planAtTime ?? null,
        });
        // When we have an attributable debit row, surface the row's
        // pro-rated share of the *actual* job-level debit (which sums to the
        // ledger's debited credits — including the job-level Math.ceil
        // quantum). This makes `creditsCharged × per-credit rate ≈ userPaidUsd`
        // hold exactly. Without attribution we fall back to the raw decimal
        // estimate so the column still has a meaningful value for in-flight
        // / failed / legacy rows.
        const creditsCharged =
          attribution.source !== null
            ? attribution.creditsAllowance + attribution.creditsBonus
            : eventCharged / MICROCENTS_PER_CREDIT;
        return {
          id: String(r._id),
          timestamp: r.timestamp.toISOString(),
          service: r.service,
          action: r.action,
          costMicroCents: r.costMicroCents,
          chargedMicroCents: eventCharged,
          creditsCharged,
          planAtTime: r.planAtTime ?? null,
          source: attribution.source,
          userPaidUsd: attribution.userPaidUsd,
          metadata: r.metadata ?? {},
        };
      }),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    },
  });
});
