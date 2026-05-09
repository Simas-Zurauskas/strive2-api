import asyncHandler from 'express-async-handler';
import { skipRecall } from '@services/recallSchedulerService';
import { analytics } from '@lib/analytics';
import { loadAuthorizedRecallCard } from './authorize';
import { parseRecallCardIdParam } from './validation';

/**
 * @swagger
 * /api/recall/{recallCardId}/skip:
 *   post:
 *     summary: Defer a recall card by 1 day without treating it as a failed review
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
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 *                   required: [nextDue]
 *                   properties:
 *                     nextDue:
 *                       type: string
 *                       format: date-time
 */
export const skipRecallController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const recallCardId = parseRecallCardIdParam(req.params.recallCardId);

  // Ownership-gated load — see authorize.ts. Rejects with 404 if either
  // the recall card doesn't exist or the caller doesn't own its course.
  const card = await loadAuthorizedRecallCard({ userId, recallCardId });

  const progress = await skipRecall({ userId, recallCardId });
  analytics.track(userId, 'recall_card_skipped', {
    card_id: recallCardId,
    course_id: card.courseId.toString(),
  });
  res.status(200).json({ data: { nextDue: progress.nextDue } });
});
