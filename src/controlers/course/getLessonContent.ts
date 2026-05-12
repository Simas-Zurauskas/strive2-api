import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { resolveImageUrl } from '@services/s3Service';
import LessonContentModel from '@models/LessonContentModel';
import RecallCardModel from '@models/RecallCardModel';
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

  // resolveImageUrl is a misleading name — the helper just turns S3 keys
  // into 7-day presigned URLs. Reusing it here for audio so we don't
  // duplicate the S3 plumbing.
  const heroImageUrl = await resolveImageUrl(content.heroImageUrl);
  const audioUrl = await resolveImageUrl(content.audioUrl);

  // Surface recall-card count so the client can render
  //   - a small "N recall cards generated" status indicator
  //   - the "Generate recall cards" CTA when count === 0 (user opted out
  //     at lesson-gen time or the lesson predates recall)
  // Indexed on (courseId, moduleIndex, lessonIndex) so this is a cheap
  // count, not a doc fetch.
  const recallCardCount = await RecallCardModel.countDocuments({
    courseId,
    moduleIndex,
    lessonIndex,
  });

  // Build the response with the derived fields layered on top of the
  // persisted document. Spreading content.toJSON() then assigning
  // overrides keeps the existing API shape AND adds `recallCardCount`
  // without TS complaining about the model type missing the field.
  const data = { ...content.toJSON(), heroImageUrl, audioUrl, recallCardCount };

  res.status(200).json({ data });
});
