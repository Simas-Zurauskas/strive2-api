import { Router } from 'express';
import {
  getProfileController,
  getStatsController,
  getQuizTrendsController,
} from '@controlers/gamification';
import { protect, requireVerified } from '@middleware/authMiddleware';

const router = Router();

router.use(protect, requireVerified);

router.get('/profile', getProfileController);
router.get('/stats', getStatsController);
router.get('/quiz-trends', getQuizTrendsController);

export { router as gamificationRoutes };
