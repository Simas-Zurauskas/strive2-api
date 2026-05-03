import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import CourseDesignChatModel from '@models/CourseDesignChatModel';

/**
 * Hardcoded fallback prompts shown when the dynamic generator hasn't run
 * yet (legacy course OR generation failed). Kept here on the server side
 * (not solely on the client) so the contract is centralised: the client
 * always trusts whatever `suggestedPrompts` the server returns and
 * doesn't need its own fallback array. Mirrors the lesson-mentor pattern
 * where the empty-state UI is a function of the server response only.
 *
 * Trim-flavoured / structural / persona-anchored mix kept short and
 * generic enough to be useful even for a brand-new course where the
 * generator hasn't run.
 */
const FALLBACK_DESIGN_PROMPTS = [
  'Why this module order?',
  'Add more practical exercises',
  'Skip the basics, I know them',
];

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
 *                   required: [messages, suggestedPrompts]
 *                   properties:
 *                     messages:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ChatHistoryMessage'
 *                     suggestedPrompts:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: >
 *                         Up to 4 opening prompts for the design-chat empty
 *                         state. Generated dynamically per course (anchored
 *                         to goal + structure + depth-mismatch signals) when
 *                         available; falls back to a small hardcoded set on
 *                         legacy courses or generator failures.
 */
export const getChatHistoryController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const session = await CourseDesignChatModel.findOne({ courseId, userId }).lean();

  // Read defensively: `suggestedDesignPrompts` is a new field; legacy
  // course documents return `undefined` until they're next saved.
  const persisted = (course as { suggestedDesignPrompts?: unknown }).suggestedDesignPrompts;
  const suggestedPrompts =
    Array.isArray(persisted) && persisted.length > 0
      ? (persisted.filter((p): p is string => typeof p === 'string'))
      : FALLBACK_DESIGN_PROMPTS;

  res.json({
    data: {
      messages: session?.messages ?? [],
      suggestedPrompts,
    },
  });
});
