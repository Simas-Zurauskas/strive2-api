import { Router } from 'express';
import { sendPromotionalTestEmailController } from '@controlers/admin';
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

// ── Email ────────────────────────────────────────────────
router.post('/email/send-promotional-test', sendPromotionalTestEmailController);

export { router as adminRoutes };
