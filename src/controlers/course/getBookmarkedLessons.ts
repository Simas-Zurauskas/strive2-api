import asyncHandler from 'express-async-handler';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import CourseModel from '@models/CourseModel';

/**
 * @swagger
 * /api/course/bookmarked-lessons:
 *   get:
 *     summary: Get all bookmarked lessons across all courses
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
 *                     $ref: '#/components/schemas/BookmarkedLessonItem'
 */
export const getBookmarkedLessonsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const bookmarks = await UserLessonProgressModel.find({
    userId,
    bookmarked: true,
  })
    .select('courseId moduleIndex lessonIndex updatedAt')
    .sort({ updatedAt: -1 })
    .lean();

  if (bookmarks.length === 0) {
    res.status(200).json({ data: [] });
    return;
  }

  const courseIds = [...new Set(bookmarks.map((b) => b.courseId.toString()))];
  const courses = await CourseModel.find({ _id: { $in: courseIds } })
    .select('name slug structure')
    .lean();
  const courseMap = new Map(courses.map((c) => [c._id.toString(), c]));

  const data = bookmarks
    .map((b) => {
      const course = courseMap.get(b.courseId.toString());
      if (!course?.structure?.modules) return null;

      const mod = course.structure.modules[b.moduleIndex];
      const lesson = mod?.lessons?.[b.lessonIndex];

      return {
        courseId: b.courseId.toString(),
        courseName: course.name || 'Untitled Course',
        courseSlug: course.slug ?? null,
        moduleIndex: b.moduleIndex,
        lessonIndex: b.lessonIndex,
        moduleName: mod?.name || `Module ${b.moduleIndex + 1}`,
        lessonName: lesson?.name || `Lesson ${b.lessonIndex + 1}`,
        bookmarkedAt: b.updatedAt.toISOString(),
      };
    })
    .filter(Boolean);

  res.status(200).json({ data });
});
