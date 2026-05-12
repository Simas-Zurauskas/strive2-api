import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import UsageEventModel from '@models/UsageEventModel';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { USAGE_SERVICES, UsageService } from '@lib/usageConstants';

/**
 * Start-of-UTC-day for the given instant. Matches the daily boundary already
 * used elsewhere in the codebase (gamification's `todayStr`) so "today" means
 * the same thing across Profile widgets.
 */
const startOfUtcDay = (d: Date): Date => {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
};

const startOfUtcMonth = (d: Date): Date => {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
};

/**
 * @swagger
 * /api/usage/summary:
 *   get:
 *     summary: Aggregated paid-action spend for the caller (microcents)
 *     tags:
 *       - Usage
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
 *                   $ref: '#/components/schemas/UsageSummary'
 */
export const getUsageSummaryController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const userObjId = new mongoose.Types.ObjectId(userId);

  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);

  // One aggregation: totals for today/month/all-time plus a per-service
  // breakdown. Grouping by null once and by service once in $facet keeps the
  // query hitting a single index (userId+timestamp).
  //
  // Each total tracks two sums:
  //   - cost: vendor spend (what we paid the provider)
  //   - charged: user-charged spend (vendor × per-service markup)
  // Legacy rows have no `chargedMicroCents` field; `$ifNull` falls them back
  // to `costMicroCents` so historical totals don't dip when read post-deploy.
  const chargedExpr = { $ifNull: ['$chargedMicroCents', '$costMicroCents'] };

  // Two parallel aggregations:
  //   1. UsageEvent → vendor cost (`costMicroCents`) and per-row charged cost
  //      (`chargedMicroCents`, vendor × markup). Drives the $ totals.
  //   2. CreditLedger → true credits debited (sum of -delta over
  //      `debit_action` rows). This is what the user actually paid out of
  //      balance and differs from `microCentsToCredits(chargedMicroCents)`
  //      because real debits ceil per-job and clamp at remaining balance.
  const [costAgg, creditAgg] = await Promise.all([
    UsageEventModel.aggregate<{
      totals: {
        todayCost: number;
        todayCharged: number;
        monthCost: number;
        monthCharged: number;
        allTimeCost: number;
        allTimeCharged: number;
      }[];
      byService: { _id: UsageService; cost: number; charged: number }[];
      // Granular per-feature breakdown. `action` is the LLM call-site
      // label ("lesson:content", "lesson:recall", "lesson:image",
      // "lesson:links", "recall:grade", etc.) so the admin Usage view
      // can answer "how much of this lesson's spend went to recall card
      // extraction vs content vs image". Top 20 keeps the row count
      // bounded on power users.
      byAction: { _id: string; cost: number; charged: number; count: number }[];
    }>([
      { $match: { userId: userObjId } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                todayCost: {
                  $sum: { $cond: [{ $gte: ['$timestamp', todayStart] }, '$costMicroCents', 0] },
                },
                todayCharged: {
                  $sum: { $cond: [{ $gte: ['$timestamp', todayStart] }, chargedExpr, 0] },
                },
                monthCost: {
                  $sum: { $cond: [{ $gte: ['$timestamp', monthStart] }, '$costMicroCents', 0] },
                },
                monthCharged: {
                  $sum: { $cond: [{ $gte: ['$timestamp', monthStart] }, chargedExpr, 0] },
                },
                allTimeCost: { $sum: '$costMicroCents' },
                allTimeCharged: { $sum: chargedExpr },
              },
            },
          ],
          byService: [
            {
              $group: {
                _id: '$service',
                cost: { $sum: '$costMicroCents' },
                charged: { $sum: chargedExpr },
              },
            },
          ],
          byAction: [
            {
              $group: {
                _id: '$action',
                cost: { $sum: '$costMicroCents' },
                charged: { $sum: chargedExpr },
                count: { $sum: 1 },
              },
            },
            { $sort: { charged: -1 } },
            { $limit: 20 },
          ],
        },
      },
    ]),
    CreditLedgerModel.aggregate<{
      todayCredits: number;
      monthCredits: number;
      allTimeCredits: number;
    }>([
      { $match: { userId: userObjId, reason: 'debit_action' } },
      {
        $group: {
          _id: null,
          todayCredits: {
            $sum: {
              $cond: [{ $gte: ['$timestamp', todayStart] }, { $multiply: ['$delta', -1] }, 0],
            },
          },
          monthCredits: {
            $sum: {
              $cond: [{ $gte: ['$timestamp', monthStart] }, { $multiply: ['$delta', -1] }, 0],
            },
          },
          allTimeCredits: { $sum: { $multiply: ['$delta', -1] } },
        },
      },
    ]),
  ]);

  const row =
    costAgg[0]?.totals?.[0] ?? {
      todayCost: 0,
      todayCharged: 0,
      monthCost: 0,
      monthCharged: 0,
      allTimeCost: 0,
      allTimeCharged: 0,
    };
  const credits = creditAgg[0] ?? {
    todayCredits: 0,
    monthCredits: 0,
    allTimeCredits: 0,
  };
  const byServiceMap = new Map<string, { cost: number; charged: number }>(
    (costAgg[0]?.byService ?? []).map((r) => [r._id, { cost: r.cost, charged: r.charged }]),
  );

  // Emit every enum value so the client can render a full chart with zero
  // bars for unused services rather than a ragged list.
  const byService = USAGE_SERVICES.map((service) => {
    const entry = byServiceMap.get(service) ?? { cost: 0, charged: 0 };
    return {
      service,
      costMicroCents: entry.cost,
      chargedMicroCents: entry.charged,
    };
  });

  res.status(200).json({
    data: {
      today: {
        costMicroCents: row.todayCost,
        chargedMicroCents: row.todayCharged,
        creditsDebited: credits.todayCredits,
      },
      thisMonth: {
        costMicroCents: row.monthCost,
        chargedMicroCents: row.monthCharged,
        creditsDebited: credits.monthCredits,
      },
      allTime: {
        costMicroCents: row.allTimeCost,
        chargedMicroCents: row.allTimeCharged,
        creditsDebited: credits.allTimeCredits,
      },
      byService,
      // Granular per-action breakdown — ordered by cost descending, top 20.
      byAction: (costAgg[0]?.byAction ?? []).map((r) => ({
        action: r._id,
        costMicroCents: r.cost,
        chargedMicroCents: r.charged,
        count: r.count,
      })),
    },
  });
});
