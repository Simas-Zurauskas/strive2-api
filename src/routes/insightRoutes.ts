import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  getInsightQueueController,
  rateInsightController,
  skipInsightController,
  setInsightModeController,
  getInsightStatsController,
  getInsightsDueCountController,
  gradeInsightAnswerController,
} from '@controlers/insight';
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
router.get('/queue', getInsightQueueController);
router.get('/stats', getInsightStatsController);
router.get('/due-count', getInsightsDueCountController);

// Parameterized (all POST) — per-insight actions.
router.post('/:insightId/rate', rateInsightController);
router.post('/:insightId/skip', skipInsightController);
router.post('/:insightId/mode', setInsightModeController);
router.post('/:insightId/grade', gradeLimiter, requireCredits(), gradeInsightAnswerController);

export { router as insightRoutes };
