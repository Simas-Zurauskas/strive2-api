import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import UsageEventModel from '@models/UsageEventModel';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const parsePositiveInt = ({ value, fallback, cap }: { value: unknown; fallback: number; cap?: number }): number => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  const intN = Math.floor(n);
  return cap !== undefined ? Math.min(intN, cap) : intN;
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

  const userObjId = new mongoose.Types.ObjectId(userId);

  const [rows, total] = await Promise.all([
    UsageEventModel.find({ userId: userObjId })
      .sort({ timestamp: -1 })
      .skip(offset)
      .limit(limit)
      .lean(),
    UsageEventModel.countDocuments({ userId: userObjId }),
  ]);

  res.status(200).json({
    data: {
      events: rows.map((r) => ({
        id: String(r._id),
        timestamp: r.timestamp.toISOString(),
        service: r.service,
        action: r.action,
        costMicroCents: r.costMicroCents,
        metadata: r.metadata ?? {},
      })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    },
  });
});
