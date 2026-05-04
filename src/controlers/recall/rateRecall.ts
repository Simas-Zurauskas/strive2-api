import asyncHandler from 'express-async-handler';
import { rateRecall } from '@services/recallSchedulerService';
import * as gamificationService from '@services/gamificationService';
import { RecallRating } from '@lib/recallConstants';
import { bgError } from '@lib/bg';
import { loadAuthorizedRecallCard } from './authorize';
import { parseRecallCardIdParam, rateRecallSchema } from './validation';

/**
 * @swagger
 * /api/recall/{recallCardId}/rate:
 *   post:
 *     summary: Submit a rating for a recall card and advance its scheduler state
 *     tags:
 *       - Recall
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: recallCardId
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
 *                 $ref: '#/components/schemas/RecallRating'
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
 *                   $ref: '#/components/schemas/RateRecallResult'
 */
export const rateRecallController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const recallCardId = parseRecallCardIdParam(req.params.recallCardId);
  const { rating, typedMatch } = rateRecallSchema.parse(req.body);

  // Verifies the recall card exists AND belongs to a course owned by this user.
  // Without this check a user could rate anyone's recall card by guessing the id.
  // Returns the full recall card so we can grab courseId for gamification below
  // without an extra query.
  const card = await loadAuthorizedRecallCard({ userId, recallCardId });

  const { progress, justMastered } = await rateRecall({
    userId,
    recallCardId,
    rating: rating as RecallRating,
    typedMatch: typedMatch ?? null,
  });

  const courseId = card.courseId.toString();
  // Fire-and-forget gamification side effects (XP + streak + achievements).
  // Never fail the rating response on a gamification error.
  gamificationService.onRecallReview({ userId, recallCardId, courseId }).catch(bgError('gamification.onRecallReview'));
  if (justMastered) {
    gamificationService.onRecallMastered({ userId, recallCardId, courseId }).catch(bgError('gamification.onRecallMastered'));
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
