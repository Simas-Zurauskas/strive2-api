import { Router } from 'express';
import {
  deleteUsageEventsController,
  getUsageHistoryController,
  getUsageSummaryController,
} from '@controlers/usage';
import { protect, requireAdmin, requireVerified } from '@middleware/authMiddleware';
import { usageContextMiddleware } from '@middleware/usageContext';

const router = Router();

// Engineer-only surfaces: raw per-call API spend in microcents, useful for
// debugging actual LLM/BFL/Tavily costs against what the user is being
// charged in credits. Stack ordering: protect → requireVerified →
// requireAdmin so a 401 only fires for genuinely unauthenticated callers
// and 403 fires for non-admin sessions (avoids tripping the client-side
// 401 → signOut interceptor for verified users who happen not to be admins).
router.use(protect, requireVerified, requireAdmin, usageContextMiddleware);

router.get('/history', getUsageHistoryController);
router.get('/summary', getUsageSummaryController);

// Wipe the caller's ledger rows. Previously dev-only; now admin-only and
// available in every environment so ops can reset their own ledger while
// iterating against staging/prod data.
router.delete('/events', deleteUsageEventsController);

export { router as usageRoutes };
