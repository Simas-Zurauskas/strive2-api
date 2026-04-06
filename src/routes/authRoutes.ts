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
} from '@controlers/auth';
import { protect } from '@middleware/authMiddleware';

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later' },
  validate: { keyGeneratorIpFallback: false },
});

const router = Router();

router.post('/signin', authLimiter, signInController);
router.post('/signup', authLimiter, signUpController);
router.post('/google', authLimiter, googleAuthController);
router.post('/verify-email', authLimiter, verifyEmailController);
router.post('/resend-verification', authLimiter, resendVerificationController);
router.get('/me', protect, getMeController);
router.post('/resend-verification-authenticated', authLimiter, protect, resendVerificationAuthenticatedController);
router.delete('/delete-account', protect, deleteAccountController);

export { router as authRoutes };
