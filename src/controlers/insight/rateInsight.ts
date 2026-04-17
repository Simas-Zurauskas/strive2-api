import asyncHandler from 'express-async-handler';
import { rateInsight } from '@services/insightSchedulerService';
import * as gamificationService from '@services/gamificationService';
import { InsightRating } from '@lib/insightConstants';
import { bgError } from '@lib/bg';
import { loadAuthorizedInsight } from './authorize';
import { parseInsightIdParam, rateInsightSchema } from './validation';

/**
 * @swagger
 * /api/insight/{insightId}/rate:
 *   post:
 *     summary: Submit a rating for an insight and advance its scheduler state
 *     tags:
 *       - Insight
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: insightId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating:
 *                 type: integer
 *                 enum: [1, 2, 3, 4]
 *                 description: '1=Again, 2=Hard, 3=Good, 4=Easy'
 *               typedMatch:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1
 *                 nullable: true
 *                 description: 'Similarity score if answered via typed-recall mode'
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/RateInsightResult'
 */
export const rateInsightController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const insightId = parseInsightIdParam(req.params.insightId);
  const { rating, typedMatch } = rateInsightSchema.parse(req.body);

  // Verifies the insight exists AND belongs to a course owned by this user.
  // Without this check a user could rate anyone's insight by guessing the id.
  // Returns the full insight so we can grab courseId for gamification below
  // without an extra query.
  const insight = await loadAuthorizedInsight({ userId, insightId });

  const { progress, justMastered } = await rateInsight({
    userId,
    insightId,
    rating: rating as InsightRating,
    typedMatch: typedMatch ?? null,
  });

  const courseId = insight.courseId.toString();
  // Fire-and-forget gamification side effects (XP + streak + achievements).
  // Never fail the rating response on a gamification error.
  gamificationService.onInsightReview(userId, insightId, courseId).catch(bgError('gamification.onInsightReview'));
  if (justMastered) {
    gamificationService.onInsightMastered(userId, insightId, courseId).catch(bgError('gamification.onInsightMastered'));
  }

  res.status(200).json({
    data: {
      box: progress.box,
      state: progress.state,
      reps: progress.reps,
      lapses: progress.lapses,
      nextDue: progress.nextDue,
      lastReview: progress.lastReview,
    },
  });
});
