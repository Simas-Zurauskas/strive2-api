import asyncHandler from 'express-async-handler';
import CourseModel from '@models/CourseModel';
import JobModel from '@models/JobModel';
import UserModel from '@models/UserModel';
import { cleanupCourseContent, cleanupCourseSources } from '@services/courseCleanupService';
import { getUserCourseLean } from '@services/courseDbService';

/**
 * @swagger
 * /api/course/{id}:
 *   delete:
 *     summary: Delete a course and its associated jobs
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *                   required: [deleted]
 *                   properties:
 *                     deleted:
 *                       type: boolean
 */
export const deleteCourseController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await getUserCourseLean({ userId, courseId: req.params.id as string });

  await Promise.all([
    JobModel.deleteMany({ courseId: course._id }),
    // `cleanupCourseContent` already deletes CourseDesignChat for this
    // course, so we don't double up here. It also covers lesson content,
    // progress, quizzes, recall cards, recall-progress, and S3 assets.
    cleanupCourseContent(course._id.toString()),
    // DELETION runs both halves of the cleanup split: content (above) AND
    // sources — SourceDocument rows, chunk rows + user-doc vectors, and the
    // whole `uploads/{userId}/{courseId}/` prefix. This is the only
    // course-deletion call site and (unlike deleteAccount) has no
    // user-scoped backstop, so skipping it here orphans docs/chunks/
    // vectors/S3 permanently.
    cleanupCourseSources({ courseId: course._id.toString(), userId }),
    // Pull this course from every user's favoriteCourseIds. Without this,
    // deleted courses leave dangling ObjectIds in users' favorites arrays
    // that show up as 404s when the home screen tries to hydrate them.
    UserModel.updateMany(
      { favoriteCourseIds: course._id },
      { $pull: { favoriteCourseIds: course._id } },
    ),
  ]);
  await CourseModel.findByIdAndDelete(course._id);

  res.status(200).json({ data: { deleted: true } });
});
