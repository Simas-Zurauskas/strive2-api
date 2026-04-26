import asyncHandler from 'express-async-handler';
import { submitJob } from '@services/jobRunner';
import { getUserCourseLean } from '@services/courseDbService';
import LessonContentModel from '@models/LessonContentModel';
import { parseIndexParam } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/lesson/{moduleIndex}/{lessonIndex}/regenerate-links:
 *   post:
 *     summary: Regenerate the curated-links block for a single already-generated lesson
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
 *       202:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 *                   required: [jobId]
 *                   properties:
 *                     jobId:
 *                       type: string
 */
export const regenerateLinksController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const lessonIndex = parseIndexParam({ value: req.params.lessonIndex, name: 'lessonIndex' });

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const mod = course.structure?.modules?.[moduleIndex];
  const lesson = mod?.lessons?.[lessonIndex];
  if (!mod || !lesson) {
    res.status(400);
    throw new Error(`Lesson not found: module ${moduleIndex}, lesson ${lessonIndex}`);
  }

  const existing = await LessonContentModel.findOne(
    { courseId, moduleIndex, lessonIndex },
  ).select('_id').lean();
  if (!existing) {
    res.status(400);
    throw new Error('Lesson content has not been generated yet');
  }

  const jobId = await submitJob({
    userId,
    courseId,
    type: 'regenerate_links',
    metadata: { moduleIndex, lessonIndex },
  });

  res.status(202).json({ data: { jobId } });
});
