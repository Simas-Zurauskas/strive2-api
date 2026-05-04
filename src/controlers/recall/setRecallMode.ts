import asyncHandler from 'express-async-handler';
import { setRecallMode } from '@services/recallSchedulerService';
import { loadAuthorizedRecallCard } from './authorize';
import { parseRecallCardIdParam, setRecallModeSchema } from './validation';

/**
 * @swagger
 * /api/recall/{recallCardId}/mode:
 *   post:
 *     summary: Switch a recall card between tap-reveal and typed-recall modes
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
 *             required: [mode]
 *             properties:
 *               mode:
 *                 $ref: '#/components/schemas/RecallMode'
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
 *                       $ref: '#/components/schemas/RecallMode'
 */
export const setRecallModeController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const recallCardId = parseRecallCardIdParam(req.params.recallCardId);
  const { mode } = setRecallModeSchema.parse(req.body);

  // Ownership-gated load — see authorize.ts. Rejects with 404 if either
  // the recall card doesn't exist or the caller doesn't own its course.
  await loadAuthorizedRecallCard({ userId, recallCardId });

  const progress = await setRecallMode({ userId, recallCardId, mode });
  res.status(200).json({ data: { mode: progress.mode } });
});
