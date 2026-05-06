import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  signInController,
  signUpController,
  googleAuthController,
  getMeController,
  verifyEmailController,
  resendVerificationController,
  resendVerificationAuthenticatedController,
  deleteAccountController,
  logoutController,
  forgotPasswordController,
  resetPasswordController,
  setPasswordController,
  changePasswordController,
  updatePreferencesController,
  requestSecurityActionCodeController,
  refreshTokenController,
  getMarketingPreferenceController,
  updateMarketingPreferenceController,
} from '@controlers/auth';
import { protect } from '@middleware/authMiddleware';
import { perEmailRateLimit } from '@middleware/perEmailRateLimit';

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later' },
  validate: { keyGeneratorIpFallback: false },
});

// Per-email throttles. These layer on top of the IP-keyed `authLimiter` so
// distributed credential-stuffing (one IP per attempt) and reset-spam
// (one bot fanning out password-reset emails to victim addresses) both
// hit a wall.
//
// Tuning rationale:
//   - signin: 10/15min/email is tight enough to stop credential stuffing
//     yet generous for a typo-prone user. The IP limiter still catches
//     spray attempts that rotate emails.
//   - forgot-password / resend-verification: 3/15min/email — these send
//     real emails and the cost (Mailjet quota + victim spam) is higher
//     than for signin. Three attempts is plenty for a fat-fingered user.
const signinPerEmail = perEmailRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  errorCode: 'RATE_LIMITED_PER_EMAIL',
  errorMessage: 'Too many sign-in attempts on this email — try again in 15 minutes.',
});

const emailDeliveryPerEmail = perEmailRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  errorCode: 'RATE_LIMITED_PER_EMAIL',
  errorMessage: 'Too many email requests for this address — try again in 15 minutes.',
});

const router = Router();

router.post('/signin', authLimiter, signinPerEmail, signInController);
router.post('/signup', authLimiter, signUpController);
router.post('/google', authLimiter, googleAuthController);
router.post('/verify-email', authLimiter, verifyEmailController);
router.post('/resend-verification', authLimiter, emailDeliveryPerEmail, resendVerificationController);
router.post('/forgot-password', authLimiter, emailDeliveryPerEmail, forgotPasswordController);
router.post('/reset-password', authLimiter, resetPasswordController);
router.post('/set-password', authLimiter, protect, setPasswordController);
router.post('/change-password', authLimiter, protect, changePasswordController);
router.get('/me', protect, getMeController);
router.patch('/me/preferences', protect, updatePreferencesController);
router.get('/me/marketing-preference', protect, getMarketingPreferenceController);
router.patch('/me/marketing-preference', protect, updateMarketingPreferenceController);
router.post('/logout', protect, logoutController);
// Sliding-refresh: issues a fresh 7-day access token to a still-valid
// session. Re-checks `tokenVersion` against the DB so revoked tokens
// can't refresh themselves back to life.
router.post('/refresh', protect, refreshTokenController);
router.post('/resend-verification-authenticated', authLimiter, protect, resendVerificationAuthenticatedController);
// Security-action OTP gate. The service itself enforces 60s spacing + 5/hr
// caps per (user, action), so we only apply the standard authLimiter here.
router.post('/security-action/request-code', authLimiter, protect, requestSecurityActionCodeController);
router.delete('/delete-account', protect, deleteAccountController);

export { router as authRoutes };
