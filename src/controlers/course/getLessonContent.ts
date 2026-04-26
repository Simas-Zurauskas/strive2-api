import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { resolveImageUrl } from '@services/s3Service';
import LessonContentModel from '@models/LessonContentModel';
import { parseIndexParam } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/lesson-content/{moduleIndex}/{lessonIndex}:
 *   get:
 *     summary: Get generated content for a specific lesson
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
 *       - in: path
 *         name: lessonIndex
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/LessonContent'
 *       404:
 *         description: Lesson content not yet generated
 */
export const getLessonContentController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const lessonIndex = parseIndexParam({ value: req.params.lessonIndex, name: 'lessonIndex' });
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const content = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });

  if (!content) {
    res.status(404).json({ message: 'Lesson content not yet generated' });
    return;
  }

  const data = content.toJSON();
  // resolveImageUrl is a misleading name — the helper just turns S3 keys
  // into 7-day presigned URLs. Reusing it here for audio so we don't
  // duplicate the S3 plumbing.
  data.heroImageUrl = await resolveImageUrl(content.heroImageUrl);
  data.audioUrl = await resolveImageUrl(content.audioUrl);

  res.status(200).json({ data });
});
