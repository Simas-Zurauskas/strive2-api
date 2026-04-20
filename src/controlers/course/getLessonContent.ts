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
  data.heroImageUrl = await resolveImageUrl(content.heroImageUrl);

  res.status(200).json({ data });
});
