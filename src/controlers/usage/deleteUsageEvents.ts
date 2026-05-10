import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import UsageEventModel from '@models/UsageEventModel';
import CreditLedgerModel from '@models/CreditLedgerModel';

// No @swagger block — intentionally hidden from API docs. Admin-only
// helper so the Usage tab can be reset without dropping the whole
// collection. Route guard (`requireAdmin`) handles the gate; this
// controller trusts that the request reached it legitimately.
//
// Wipes two scopes side-by-side so the engineer view zeros out cleanly:
//   1. UsageEvent rows → resets vendor/charged $ cards + history list.
//   2. CreditLedger rows for action-related reasons → resets the
//      "credits debited" cards. We deliberately keep grants / period-resets
//      / topup-purchases / clawbacks intact since those reflect financial
//      state (and Stripe webhook idempotency depends on the unique
//      `stripeEventId` index on topup/refund rows). User.credits balance
//      itself is left untouched — same policy as the prior single-scope
//      wipe.
const ACTION_LEDGER_REASONS = [
  'debit_action',
  'refund_job_failed',
  'refund_job_canceled',
  'refund_cross_period',
] as const;

export const deleteUsageEventsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const userObjId = new mongoose.Types.ObjectId(userId);

  const [usageResult, ledgerResult] = await Promise.all([
    UsageEventModel.deleteMany({ userId: userObjId }),
    CreditLedgerModel.deleteMany({
      userId: userObjId,
      reason: { $in: [...ACTION_LEDGER_REASONS] },
    }),
  ]);

  res.status(200).json({
    data: {
      deleted: usageResult.deletedCount ?? 0,
      ledgerDeleted: ledgerResult.deletedCount ?? 0,
    },
  });
});
