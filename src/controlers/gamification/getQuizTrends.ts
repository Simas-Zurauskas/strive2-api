import asyncHandler from 'express-async-handler';
import { getQuizTrends } from '@services/gamificationService';

/**
 * @swagger
 * /api/gamification/quiz-trends:
 *   get:
 *     summary: Get all quiz attempt scores over time for trend visualization
 *     tags:
 *       - Gamification
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/QuizTrendsResult'
 */
export const getQuizTrendsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const data = await getQuizTrends(userId);
  res.status(200).json({ data });
});
