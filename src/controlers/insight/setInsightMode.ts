import asyncHandler from 'express-async-handler';
import { setInsightMode } from '@services/insightSchedulerService';
import { loadAuthorizedInsight } from './authorize';
import { parseInsightIdParam, setInsightModeSchema } from './validation';

/**
 * @swagger
 * /api/insight/{insightId}/mode:
 *   post:
 *     summary: Switch an insight between tap-reveal and typed-recall modes
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
 *             required: [mode]
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [tap-reveal, typed-recall]
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
 *                   required: [mode]
 *                   properties:
 *                     mode:
 *                       type: string
 *                       enum: [tap-reveal, typed-recall]
 */
export const setInsightModeController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const insightId = parseInsightIdParam(req.params.insightId);
  const { mode } = setInsightModeSchema.parse(req.body);

  // Ownership-gated load — see authorize.ts. Rejects with 404 if either
  // the insight doesn't exist or the caller doesn't own its course.
  await loadAuthorizedInsight({ userId, insightId });

  const progress = await setInsightMode({ userId, insightId, mode });
  res.status(200).json({ data: { mode: progress.mode } });
});
