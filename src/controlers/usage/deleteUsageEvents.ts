import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import { ENVIRONMENT } from '@conf/env';
import UsageEventModel from '@models/UsageEventModel';

// No @swagger block — intentionally hidden from API docs. Dev-only helper
// so the Usage tab can be reset without dropping the whole collection.
export const deleteUsageEventsController = asyncHandler(async (req, res) => {
  if (ENVIRONMENT !== 'development') {
    res.status(404).json({ message: 'Not found' });
    return;
  }

  const userId = req.userId!;
  const result = await UsageEventModel.deleteMany({
    userId: new mongoose.Types.ObjectId(userId),
  });

  res.status(200).json({
    data: { deleted: result.deletedCount ?? 0 },
  });
});
