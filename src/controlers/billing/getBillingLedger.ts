import mongoose from 'mongoose';
import asyncHandler from 'express-async-handler';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { ledgerQuerySchema } from './validation';

/**
 * @swagger
 * /api/billing/ledger:
 *   get:
 *     summary: Paginated credit ledger (billing history) for the authenticated user
 *     tags: [Billing]
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
 *         name: before
 *         schema:
 *           type: string
 *         description: Ledger entry _id cursor from the previous page's last row.
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
 *                   required: [rows, nextCursor]
 *                   properties:
 *                     rows:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/CreditLedgerEntry'
 *                     nextCursor:
 *                       type: string
 *                       nullable: true
 */
export const getBillingLedgerController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { limit, before } = ledgerQuerySchema.parse(req.query);

  // Cursor: rows older than `before`'s _id. `_id` is monotonically increasing
  // in time, so _id-based pagination preserves timestamp ordering without an
  // extra sort key. If `before` is malformed, treat it as absent (don't 400 —
  // stale client cursors shouldn't break a history reload).
  const filter: Record<string, unknown> = { userId };
  if (before && mongoose.Types.ObjectId.isValid(before)) {
    filter._id = { $lt: new mongoose.Types.ObjectId(before) };
  }

  const rows = await CreditLedgerModel
    .find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1) // over-fetch by 1 to detect "has next page"
    .lean();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]._id.toString() : null;

  res.json({ data: { rows: page, nextCursor } });
});
