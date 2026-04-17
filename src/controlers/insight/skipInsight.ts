import asyncHandler from 'express-async-handler';
import { skipInsight } from '@services/insightSchedulerService';
import { loadAuthorizedInsight } from './authorize';
import { parseInsightIdParam } from './validation';

/**
 * @swagger
 * /api/insight/{insightId}/skip:
 *   post:
 *     summary: Defer an insight by 1 day without treating it as a failed review
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
export const skipInsightController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const insightId = parseInsightIdParam(req.params.insightId);

  // Ownership-gated load — see authorize.ts. Rejects with 404 if either
  // the insight doesn't exist or the caller doesn't own its course.
  await loadAuthorizedInsight({ userId, insightId });

  const progress = await skipInsight({ userId, insightId });
  res.status(200).json({ data: { nextDue: progress.nextDue } });
});
