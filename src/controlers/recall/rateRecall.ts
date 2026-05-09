import asyncHandler from 'express-async-handler';
import { rateRecall } from '@services/recallSchedulerService';
import * as gamificationService from '@services/gamificationService';
import { RecallRating } from '@lib/recallConstants';
import { bgError } from '@lib/bg';
import { analytics } from '@lib/analytics';
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

  // Snapshot the previous box BEFORE the scheduler advances it so the
  // analytics event can carry both the from-box and the to-box without
  // a follow-up query.
  const previousBox = (card as { box?: number }).box ?? null;
  const { progress, justMastered } = await rateRecall({
    userId,
    recallCardId,
    rating: rating as RecallRating,
    typedMatch: typedMatch ?? null,
  });

  const courseId = card.courseId.toString();
  analytics.track(userId, 'recall_card_rated', {
    card_id: recallCardId,
    course_id: courseId,
    rating,
    ...(previousBox !== null && { previous_box: previousBox }),
    next_box: progress.box,
    mastered_now: justMastered === true,
    ...(typeof typedMatch === 'number' && { similarity_score: typedMatch }),
  });
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
