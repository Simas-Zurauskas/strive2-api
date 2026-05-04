import { Router } from 'express';
import {
  cancelSubscriptionController,
  downgradeController,
  getBillingLedgerController,
  getBillingPlansController,
  getBillingSummaryController,
  startCheckoutController,
  startPortalController,
  startTopupController,
} from '@controlers/billing';
import { protect } from '@middleware/authMiddleware';

const router = Router();

// Public: the pricing page should be reachable without auth so unauthenticated
// visitors can see plans + decide to sign up. Must come BEFORE the `protect`
// router-wide mount below so it doesn't inherit the auth gate.
router.get('/plans', getBillingPlansController);

// Intentionally NOT behind `requireVerified` — an unverified user must still
// be able to subscribe (some users want to pay before verifying), manage
// their subscription, and see their billing history. Feature routes
// (course, recall, …) stay gated by `requireVerified` separately.
router.use(protect);

router.post('/checkout', startCheckoutController);
router.post('/topup', startTopupController);
router.post('/portal', startPortalController);
router.post('/downgrade', downgradeController);
router.post('/cancel', cancelSubscriptionController);
router.get('/summary', getBillingSummaryController);
router.get('/ledger', getBillingLedgerController);

export { router as billingRoutes };
