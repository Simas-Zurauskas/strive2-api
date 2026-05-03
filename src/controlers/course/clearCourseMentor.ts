import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import CourseMentorChatModel from '@models/CourseMentorChatModel';

/**
 * Delete the course-mentor session for a `(userId, courseId)`. Mirrors
 * `clearLessonChat.ts` — same shape, narrower scope (no module/lesson
 * indices). The session is independent of the lesson-mentor sessions;
 * clearing this does NOT touch any of the per-lesson chats.
 *
 * @swagger
 * /api/course/{courseId}/mentor/chat:
 *   delete:
 *     summary: Delete the course-mentor (compass) chat session for a learner
 *     tags: [Course]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema: { type: string }
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
export const clearCourseMentorController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  await CourseMentorChatModel.deleteOne({ courseId, userId });

  res.json({ data: { ok: true } });
});
