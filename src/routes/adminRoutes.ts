import { Router } from 'express';
import {
  getFreeTierSpendController,
  sendPromotionalTestEmailController,
  sendMarketingCampaignController,
  listMarketingCampaignClaimsController,
  reclaimMarketingCampaignClaimsController,
} from '@controlers/admin';
import { protect, requireAdmin, requireVerified } from '@middleware/authMiddleware';

const router = Router();

// Operator surfaces. Stack ordering matches the engineering-only routes
// elsewhere (see usageRoutes): protect → requireVerified → requireAdmin
// so a 401 only fires for genuinely unauthenticated callers and 403 fires
// for non-admins (avoids tripping the client's 401 → signOut interceptor
// for verified users who happen not to be admins).
//
// New admin endpoints land here as routes are added. Keep them grouped by
// resource (`/email/...`, `/users/...`, etc.) rather than flat.
router.use(protect, requireVerified, requireAdmin);

// ── Metrics ──────────────────────────────────────────────
// Free-plan provider spend. This is the cost control for the 2026-09-02
// onboarding grant (pricingConfig KNOB 9): the grant is one config integer
// with a 30-day lag, so the only thing that makes it risky is not looking.
router.get('/metrics/free-tier-spend', getFreeTierSpendController);

// ── Email ────────────────────────────────────────────────
router.post('/email/send-promotional-test', sendPromotionalTestEmailController);

// ── Promotional campaigns ───────────────────────────────
// Batch send + the stranded-claim recovery pair. All three inherit the
// router-level `protect → requireVerified → requireAdmin` gate above.
router.post('/marketing/send', sendMarketingCampaignController);
router.get('/marketing/claims', listMarketingCampaignClaimsController);
router.post('/marketing/reclaim', reclaimMarketingCampaignClaimsController);

export { router as adminRoutes };
