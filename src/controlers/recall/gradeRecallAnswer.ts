import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import { gradeTypedAnswer } from '@services/recallGradingService';
import { loadAuthorizedRecallCard } from './authorize';
import { parseRecallCardIdParam } from './validation';

const gradeSchema = z.object({
  userAnswer: z.string().min(1, 'userAnswer is required').max(1000, 'userAnswer too long'),
});

/**
 * @swagger
 * /api/recall/{recallCardId}/grade:
 *   post:
 *     summary: Grade a learner's typed-recall answer against the canonical (Haiku + Levenshtein short-circuit)
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
 *             required: [userAnswer]
 *             properties:
 *               userAnswer:
 *                 type: string
 *                 maxLength: 1000
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/GradeResult'
 */
export const gradeRecallAnswerController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const recallCardId = parseRecallCardIdParam(req.params.recallCardId);
  const { userAnswer } = gradeSchema.parse(req.body);

  // The recall card itself is the source of truth for prompt + canonical answer —
  // never trust the client to pass them. That also guards against prompt
  // injection attempts from a modified frontend. Ownership-gated to prevent
  // grading another user's recall card by guessing the id (BOLA).
  const card = await loadAuthorizedRecallCard({ userId, recallCardId });

  const grade = await gradeTypedAnswer({
    prompt: card.prompt,
    canonicalAnswer: card.answer,
    userAnswer,
    kind: card.kind,
  });

  res.status(200).json({ data: grade });
});
