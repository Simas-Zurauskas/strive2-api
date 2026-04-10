import asyncHandler from 'express-async-handler';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import CourseModel from '@models/CourseModel';

/**
 * @swagger
 * /api/course/recent-activity:
 *   get:
 *     summary: Get recently accessed lessons across all courses
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
 *                     type: object
 *                     required: [courseId, courseSlug, courseName, moduleIndex, lessonIndex, moduleName, lessonName, lastAccessedAt]
 *                     properties:
 *                       courseId:
 *                         type: string
 *                       courseSlug:
 *                         type: string
 *                         nullable: true
 *                       courseName:
 *                         type: string
 *                       moduleIndex:
 *                         type: number
 *                       lessonIndex:
 *                         type: number
 *                       moduleName:
 *                         type: string
 *                       lessonName:
 *                         type: string
 *                       lastAccessedAt:
 *                         type: string
 *                         format: date-time
 */
export const getRecentActivityController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const recentProgress = await UserLessonProgressModel.find({ userId })
    .select('courseId moduleIndex lessonIndex lastAccessedAt')
    .sort({ lastAccessedAt: -1 })
    .limit(5)
    .lean();

  if (recentProgress.length === 0) {
    res.status(200).json({ data: [] });
    return;
  }

  const courseIds = [...new Set(recentProgress.map((p) => p.courseId.toString()))];
  const courses = await CourseModel.find({ _id: { $in: courseIds } })
    .select('name slug structure')
    .lean();
  const courseMap = new Map(courses.map((c) => [c._id.toString(), c]));

  const data = recentProgress
    .map((p) => {
      const course = courseMap.get(p.courseId.toString());
      if (!course?.structure?.modules) return null;

      const mod = course.structure.modules[p.moduleIndex];
      const lesson = mod?.lessons?.[p.lessonIndex];

      return {
        courseId: p.courseId.toString(),
        courseSlug: course.slug ?? null,
        courseName: course.name || 'Untitled Course',
        moduleIndex: p.moduleIndex,
        lessonIndex: p.lessonIndex,
        moduleName: mod?.name || `Module ${p.moduleIndex + 1}`,
        lessonName: lesson?.name || `Lesson ${p.lessonIndex + 1}`,
        lastAccessedAt: p.lastAccessedAt.toISOString(),
      };
    })
    .filter(Boolean);

  res.status(200).json({ data });
});
