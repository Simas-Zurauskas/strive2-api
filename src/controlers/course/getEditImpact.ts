import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { getEditImpact } from '@services/courseCleanupService';

/**
 * @swagger
 * /api/course/{courseId}/edit-impact:
 *   get:
 *     summary: Assess the impact of editing a course (content and progress that would be lost)
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
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
 *                   properties:
 *                     hasContent:
 *                       type: boolean
 *                     hasProgress:
 *                       type: boolean
 *                     completedLessons:
 *                       type: number
 *                     inProgressLessons:
 *                       type: number
 *                     totalNotes:
 *                       type: number
 *                     totalBookmarks:
 *                       type: number
 *                     quizAttempts:
 *                       type: number
 *                     modulesWithMastery:
 *                       type: number
 *                     scheduledReviews:
 *                       type: number
 *                     totalTimeSpentMinutes:
 *                       type: number
 */
export const getEditImpactController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const impact = await getEditImpact({ courseId, userId });

  res.status(200).json({ data: impact });
});
