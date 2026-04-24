import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import UsageEventModel from '@models/UsageEventModel';
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
  const agg = await UsageEventModel.aggregate<{
    totals: { today: number; thisMonth: number; allTime: number }[];
    byService: { _id: UsageService; total: number }[];
  }>([
    { $match: { userId: userObjId } },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              today: {
                $sum: {
                  $cond: [{ $gte: ['$timestamp', todayStart] }, '$costMicroCents', 0],
                },
              },
              thisMonth: {
                $sum: {
                  $cond: [{ $gte: ['$timestamp', monthStart] }, '$costMicroCents', 0],
                },
              },
              allTime: { $sum: '$costMicroCents' },
            },
          },
        ],
        byService: [
          { $group: { _id: '$service', total: { $sum: '$costMicroCents' } } },
        ],
      },
    },
  ]);

  const row = agg[0]?.totals?.[0] ?? { today: 0, thisMonth: 0, allTime: 0 };
  const byServiceMap = new Map<string, number>(
    (agg[0]?.byService ?? []).map((r) => [r._id, r.total]),
  );

  // Emit every enum value so the client can render a full chart with zero
  // bars for unused services rather than a ragged list.
  const byService = USAGE_SERVICES.map((service) => ({
    service,
    costMicroCents: byServiceMap.get(service) ?? 0,
  }));

  res.status(200).json({
    data: {
      today: { costMicroCents: row.today },
      thisMonth: { costMicroCents: row.thisMonth },
      allTime: { costMicroCents: row.allTime },
      byService,
    },
  });
});
