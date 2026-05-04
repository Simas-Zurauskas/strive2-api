import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  getRecallQueueController,
  rateRecallController,
  skipRecallController,
  setRecallModeController,
  getRecallStatsController,
  getRecallDueCountController,
  gradeRecallAnswerController,
} from '@controlers/recall';
import { protect, requireVerified } from '@middleware/authMiddleware';
import { usageContextMiddleware } from '@middleware/usageContext';
import { requireCredits } from '@middleware/requireCredits';

const router = Router();

// Grading hits an LLM; bound it per-user to keep costs predictable and
// shield against runaway clients. 120/hour comfortably exceeds normal use
// (a motivated user reviews maybe 50 cards/day in typed mode).
const gradeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many grading requests — slow down.' },
  keyGenerator: (req) => req.userId ?? req.ip ?? 'anon',
  validate: { keyGeneratorIpFallback: false },
});

router.use(protect, requireVerified, usageContextMiddleware);

// Static paths must precede any parameterized ones (CLAUDE.md convention).
router.get('/queue', getRecallQueueController);
router.get('/stats', getRecallStatsController);
router.get('/due-count', getRecallDueCountController);

// Parameterized (all POST) — per-recall-card actions.
router.post('/:recallCardId/rate', rateRecallController);
router.post('/:recallCardId/skip', skipRecallController);
router.post('/:recallCardId/mode', setRecallModeController);
router.post('/:recallCardId/grade', gradeLimiter, requireCredits(), gradeRecallAnswerController);

export { router as recallRoutes };
