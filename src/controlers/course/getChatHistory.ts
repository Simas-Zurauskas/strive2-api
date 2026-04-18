import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import CourseDesignChatModel from '@models/CourseDesignChatModel';

/**
 * @swagger
 * /api/course/{courseId}/chat/history:
 *   get:
 *     summary: Get chat history for course structure refinement
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
 *                   required: [messages]
 *                   properties:
 *                     messages:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           role:
 *                             type: string
 *                             enum: [user, assistant]
 *                           content:
 *                             type: string
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 */
export const getChatHistoryController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const session = await CourseDesignChatModel.findOne({ courseId, userId }).lean();

  res.json({
    data: {
      messages: session?.messages ?? [],
    },
  });
});
