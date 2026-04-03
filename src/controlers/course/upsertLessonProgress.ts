import asyncHandler from 'express-async-handler';
import { getUserCourse } from '@services/courseDbService';
import { upsertLessonProgress } from '@services/progressService';
import { upsertProgressSchema } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/progress/{moduleIndex}/{lessonIndex}:
 *   post:
 *     summary: Upsert lesson progress (mark complete, update notes, track time, etc.)
 *     tags:
 *       - Progress
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: moduleIndex
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: lessonIndex
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [not_started, in_progress, completed]
 *               notes:
 *                 type: string
 *                 nullable: true
 *               bookmarked:
 *                 type: boolean
 *               timeSpentDelta:
 *                 type: integer
 *                 description: Seconds to add to cumulative time
 *               quizResponse:
 *                 $ref: '#/components/schemas/QuizResponse'
 *               exerciseAttempt:
 *                 $ref: '#/components/schemas/ExerciseAttempt'
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/UserLessonProgress'
 */
export const upsertLessonProgressController = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId as string;
  const userId = req.userId!;
  const moduleIndex = Number(req.params.moduleIndex);
  const lessonIndex = Number(req.params.lessonIndex);

  // Verify ownership
  await getUserCourse({ userId, courseId });

  const body = upsertProgressSchema.parse(req.body);

  const progress = await upsertLessonProgress({
    userId,
    courseId,
    moduleIndex,
    lessonIndex,
    ...body,
  });

  res.status(200).json({ data: progress });
});
