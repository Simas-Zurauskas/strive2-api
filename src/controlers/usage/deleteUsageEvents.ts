import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import UsageEventModel from '@models/UsageEventModel';

// No @swagger block — intentionally hidden from API docs. Admin-only
// helper so the Usage tab can be reset without dropping the whole
// collection. Route guard (`requireAdmin`) handles the gate; this
// controller trusts that the request reached it legitimately.
export const deleteUsageEventsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const result = await UsageEventModel.deleteMany({
    userId: new mongoose.Types.ObjectId(userId),
  });

  res.status(200).json({
    data: { deleted: result.deletedCount ?? 0 },
  });
});
