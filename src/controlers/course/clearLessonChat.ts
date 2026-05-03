import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import LessonMentorChatModel from '@models/LessonMentorChatModel';

/**
 * @swagger
 * /api/course/{courseId}/lesson/{moduleIndex}/{lessonIndex}/mentor/chat:
 *   delete:
 *     summary: Delete the lesson-mentor chat session for a learner
 *     tags: [Course]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: moduleIndex
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: lessonIndex
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/OkResponse'
 */
export const clearLessonChatController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const moduleIndex = parseInt(req.params.moduleIndex as string, 10);
  const lessonIndex = parseInt(req.params.lessonIndex as string, 10);

  if (isNaN(moduleIndex) || isNaN(lessonIndex)) {
    res.status(400).json({ message: 'Invalid moduleIndex or lessonIndex' });
    return;
  }

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  await LessonMentorChatModel.deleteOne({ courseId, userId, moduleIndex, lessonIndex });

  res.json({ data: { ok: true } });
});
