import asyncHandler from 'express-async-handler';
import { getUserCourse } from '@services/courseDbService';
import LessonContentModel from '@models/LessonContentModel';

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
  const courseId = req.params.courseId as string;
  const userId = req.userId!;
  const moduleIndex = Number(req.params.moduleIndex);
  const lessonIndex = Number(req.params.lessonIndex);

  await getUserCourse({ userId, courseId });

  const content = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });

  if (!content) {
    res.status(404).json({ message: 'Lesson content not yet generated' });
    return;
  }

  res.status(200).json({ data: content });
});
