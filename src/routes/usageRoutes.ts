import { Router } from 'express';
import {
  deleteUsageEventsController,
  getUsageHistoryController,
  getUsageSummaryController,
} from '@controlers/usage';
import { ENVIRONMENT } from '@conf/env';
import { protect, requireVerified } from '@middleware/authMiddleware';
import { usageContextMiddleware } from '@middleware/usageContext';

const router = Router();

// Same gate as every other feature router (CLAUDE.md convention) + enter the
// usage-tracking scope so any paid action this router triggers later (none
// today, but keeps the invariant uniform) still attributes correctly.
router.use(protect, requireVerified, usageContextMiddleware);

router.get('/history', getUsageHistoryController);
router.get('/summary', getUsageSummaryController);

// Dev-only: wipe the caller's ledger rows so the Usage tab can be reset
// while iterating on the feature. The controller itself 404s in non-dev
// environments, but we also mount it conditionally to keep it off the
// Swagger surface in production.
if (ENVIRONMENT === 'development') {
  router.delete('/events', deleteUsageEventsController);
}

export { router as usageRoutes };
