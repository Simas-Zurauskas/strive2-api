import asyncHandler from 'express-async-handler';
import { Request, Response } from 'express';
import { z } from 'zod';
import UsageEventModel from '@models/UsageEventModel';

/**
 * Free-plan cost visibility.
 *
 * This is the control that makes the 2026-09-02 onboarding grant safe to run:
 * KNOB 9 raised a new account's starting allowance from 200 to 650 credits
 * (~2 lessons to ~5), and the only prior way to notice a runaway was the
 * provider invoice, weeks after the fact. The exposure is a single config
 * integer with a 30-day lag, so the one thing that makes it dangerous is not
 * looking.
 *
 * Two data hazards this deliberately does NOT paper over:
 *
 *   1. `chargedMicroCents` is optional and the model prescribes treating a
 *      missing value as equal to `costMicroCents`. A bare `$sum` on the field
 *      contributes 0 for those rows and would report charged < vendor, which
 *      cannot happen in reality.
 *   2. `planAtTime` is absent for rows recorded outside an authenticated or
 *      job scope, and for rows predating the field. Filtering on
 *      `planAtTime: 'free'` therefore silently excludes spend that may well
 *      be free-plan spend. Those rows are returned as `unattributedEvents`
 *      so the number is read with its own uncertainty attached, rather than
 *      under-reporting the exact metric this endpoint exists to expose.
 *
 * Units: `costMicroCents` is denominated so that 1,000,000 units === 1 USD.
 */

const MICRO_UNITS_PER_USD = 1_000_000;

export const freeTierSpendQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export interface FreeTierSpend {
  windowDays: number;
  vendorUsd: number;
  chargedUsd: number;
  events: number;
  users: number;
  /** Rows in the window with no `planAtTime` — cannot be attributed either way. */
  unattributedEvents: number;
}

export const computeFreeTierSpend = async (params: { days: number }): Promise<FreeTierSpend> => {
  const since = new Date(Date.now() - params.days * 24 * 60 * 60 * 1000);

  const [freeAgg, unattributed] = await Promise.all([
    UsageEventModel.aggregate<{
      vendor: number;
      charged: number;
      events: number;
      users: string[];
    }>([
      { $match: { timestamp: { $gte: since }, planAtTime: 'free' } },
      {
        $group: {
          _id: null,
          vendor: { $sum: '$costMicroCents' },
          // Model-prescribed fallback, not a bare $sum.
          charged: { $sum: { $ifNull: ['$chargedMicroCents', '$costMicroCents'] } },
          events: { $sum: 1 },
          users: { $addToSet: '$userId' },
        },
      },
    ]),
    // `$exists: false` rather than `$in: [null, undefined]` — the field is
    // simply absent on rows written outside an authenticated/job scope and on
    // rows predating it, and the `$in` form does not type against Mongoose's
    // FilterQuery for an optional enum.
    UsageEventModel.countDocuments({
      timestamp: { $gte: since },
      planAtTime: { $exists: false },
    }),
  ]);

  const row = freeAgg[0];

  return {
    windowDays: params.days,
    vendorUsd: (row?.vendor ?? 0) / MICRO_UNITS_PER_USD,
    chargedUsd: (row?.charged ?? 0) / MICRO_UNITS_PER_USD,
    events: row?.events ?? 0,
    users: row?.users?.length ?? 0,
    unattributedEvents: unattributed,
  };
};

/**
 * @swagger
 * /api/admin/metrics/free-tier-spend:
 *   get:
 *     summary: Free-plan provider spend over a trailing window
 *     description: >
 *       Admin-only. Aggregates `UsageEvent` rows whose `planAtTime` is `free`.
 *       `chargedUsd` applies the model's documented fallback to `costMicroCents`
 *       where `chargedMicroCents` is absent. `unattributedEvents` counts rows in
 *       the window with no `planAtTime` — they are excluded from the totals and
 *       reported separately rather than dropped.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 1, maximum: 365, default: 30 }
 *     responses:
 *       200:
 *         description: Spend summary
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FreeTierSpend'
 */
export const getFreeTierSpendController = asyncHandler(async (req: Request, res: Response) => {
  const { days } = freeTierSpendQuerySchema.parse(req.query);
  res.json(await computeFreeTierSpend({ days }));
});
