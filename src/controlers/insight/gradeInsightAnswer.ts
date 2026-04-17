import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import { gradeTypedAnswer } from '@services/insightGradingService';
import { loadAuthorizedInsight } from './authorize';
import { parseInsightIdParam } from './validation';

const gradeSchema = z.object({
  userAnswer: z.string().min(1, 'userAnswer is required').max(1000, 'userAnswer too long'),
});

/**
 * @swagger
 * /api/insight/{insightId}/grade:
 *   post:
 *     summary: Grade a learner's typed-recall answer against the canonical (Haiku + Levenshtein short-circuit)
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
export const gradeInsightAnswerController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const insightId = parseInsightIdParam(req.params.insightId);
  const { userAnswer } = gradeSchema.parse(req.body);

  // The insight itself is the source of truth for prompt + canonical answer —
  // never trust the client to pass them. That also guards against prompt
  // injection attempts from a modified frontend. Ownership-gated to prevent
  // grading another user's insight by guessing the id (BOLA).
  const insight = await loadAuthorizedInsight({ userId, insightId });

  const grade = await gradeTypedAnswer({
    prompt: insight.prompt,
    canonicalAnswer: insight.answer,
    userAnswer,
    kind: insight.kind,
  });

  res.status(200).json({ data: grade });
});
