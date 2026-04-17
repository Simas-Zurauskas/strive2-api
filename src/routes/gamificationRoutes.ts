import { Router } from 'express';
import {
  getProfileController,
  getStatsController,
  getQuizTrendsController,
  useStreakFreezeController,
} from '@controlers/gamification';
import { protect } from '@middleware/authMiddleware';

const router = Router();

router.get('/profile', protect, getProfileController);
router.get('/stats', protect, getStatsController);
router.get('/quiz-trends', protect, getQuizTrendsController);
router.post('/streak-freeze', protect, useStreakFreezeController);

export { router as gamificationRoutes };
