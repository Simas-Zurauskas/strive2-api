import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { clearLessonNarration } from '@services/lessonNarrationService';
import { parseIndexParam } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/lesson/{moduleIndex}/{lessonIndex}/narration:
 *   delete:
 *     summary: Clear the narration audio reference on a lesson (does not delete the S3 object — it may be reused via content-hash dedup)
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
 *       - in: path
 *         name: moduleIndex
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 0
 *       - in: path
 *         name: lessonIndex
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 0
 *     responses:
 *       204:
 *         description: Narration cleared.
 */
export const deleteLessonNarrationController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const lessonIndex = parseIndexParam({ value: req.params.lessonIndex, name: 'lessonIndex' });

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  await clearLessonNarration({ courseId, moduleIndex, lessonIndex });

  res.status(204).end();
});
