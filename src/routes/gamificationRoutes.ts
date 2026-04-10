import { Router } from 'express';
import {
  getProfileController,
  getStatsController,
  useStreakFreezeController,
} from '@controlers/gamification';
import { protect } from '@middleware/authMiddleware';

const router = Router();

router.get('/profile', protect, getProfileController);
router.get('/stats', protect, getStatsController);
router.post('/streak-freeze', protect, useStreakFreezeController);

export { router as gamificationRoutes };
