import asyncHandler from 'express-async-handler';
import { getReviewsDue } from '@services/progressService';

/**
 * @swagger
 * /api/course/reviews-due:
 *   get:
 *     summary: Get all module quizzes due for review across all courses
 *     tags:
 *       - Progress
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
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReviewDueItem'
 */
export const getReviewsDueController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const reviews = await getReviewsDue({ userId });

  res.status(200).json({ data: reviews });
});
