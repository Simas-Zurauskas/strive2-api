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
import { protect } from '@middleware/authMiddleware';

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

// Static paths must precede any parameterized ones (CLAUDE.md convention).
router.get('/queue', protect, getInsightQueueController);
router.get('/stats', protect, getInsightStatsController);
router.get('/due-count', protect, getInsightsDueCountController);

// Parameterized (all POST) — per-insight actions.
router.post('/:insightId/rate', protect, rateInsightController);
router.post('/:insightId/skip', protect, skipInsightController);
router.post('/:insightId/mode', protect, setInsightModeController);
router.post('/:insightId/grade', protect, gradeLimiter, gradeInsightAnswerController);

export { router as insightRoutes };
