import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { getCourseProgress } from '@services/progressService';
import { getCourseQuizProgress } from '@services/reviewSchedulingService';

/**
 * @swagger
 * /api/course/{courseId}/progress:
 *   get:
 *     summary: Get all lesson progress for a course with aggregate stats
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
 *                   required: [lessons, quizzes, stats]
 *                   properties:
 *                     lessons:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/UserLessonProgress'
 *                     quizzes:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/CourseQuizProgressItem'
 *                     stats:
 *                       $ref: '#/components/schemas/CourseProgressStats'
 */
export const getCourseProgressController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();
  const totalModules = course.structure?.modules?.length ?? 0;

  const [lessons, quizzes] = await Promise.all([
    getCourseProgress({ userId, courseId }),
    getCourseQuizProgress({ userId, courseId, totalModules }),
  ]);

  // Compute stats from course structure
  const totalLessons = course.structure?.modules?.reduce(
    (sum, m) => sum + (m.lessons?.length ?? 0),
    0,
  ) ?? 0;

  const completed = lessons.filter((l) => l.status === 'completed').length;
  const inProgress = lessons.filter((l) => l.status === 'in_progress').length;

  res.status(200).json({
    data: {
      lessons,
      quizzes,
      stats: {
        total: totalLessons,
        completed,
        inProgress,
        percentage: totalLessons > 0 ? Math.round((completed / totalLessons) * 100) : 0,
      },
    },
  });
});
