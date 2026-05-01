import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import {
  attachToSession,
  type AttachToSessionError,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_TOTAL_TOKENS_PER_SESSION,
} from '@services/attachmentSessionService';

/**
 * POST /api/course/:courseId/lesson/:moduleIndex/:lessonIndex/mentor/attachment
 *
 * Multipart upload (field name: `file`). On success the file is
 * extracted, deduped by sha256 against the chat session's existing
 * attachments, and persisted on the `LessonMentorChat` doc. The
 * response carries metadata only — never the extracted text. The
 * client refers to the attachment by id from then on.
 *
 * Auth: standard course-route stack (`protect` + `requireVerified` +
 * `usageContextMiddleware` from `courseRoutes.ts`). No credit gate —
 * extraction does no LLM work; the downstream chat turn pays for the
 * additional input tokens via the regular Anthropic billing.
 */

const ERROR_MESSAGES: Record<AttachToSessionError, { status: number; message: string }> = {
  empty_file: { status: 400, message: 'The file is empty.' },
  pdf_no_text: {
    status: 400,
    message: "The PDF has no embedded text (likely scanned). Re-upload an OCR'd version.",
  },
  pdf_parse_failed: {
    status: 400,
    message: 'Could not read the PDF. It may be password-protected or corrupted.',
  },
  binary_in_text: {
    status: 400,
    message: 'The file looks binary, not text. Only PDFs and plain-text formats are supported.',
  },
  extraction_failed: { status: 500, message: 'Extraction failed unexpectedly.' },
  oversize: {
    status: 413,
    message:
      'The file is too long once extracted (>50,000 tokens). Please attach a shorter excerpt.',
  },
  session_count_cap: {
    status: 413,
    message: `You've reached the limit of ${MAX_ATTACHMENTS_PER_SESSION} attachments in this conversation. Clear the chat to add another.`,
  },
  session_token_cap: {
    status: 413,
    message: `Your attached files would exceed this conversation's ${MAX_TOTAL_TOKENS_PER_SESSION.toLocaleString()}-token budget. Try a shorter excerpt or clear the chat.`,
  },
};

/**
 * @swagger
 * /api/course/{courseId}/lesson/{moduleIndex}/{lessonIndex}/mentor/attachment:
 *   post:
 *     summary: Upload a file to the lesson-mentor chat session
 *     description: >
 *       Multipart upload (field name `file`). Server extracts text,
 *       dedupes by sha256 against the session, enforces session caps
 *       (5 files / 120K tokens), and persists on the LessonMentorChat
 *       doc. The response carries metadata only — never the extracted
 *       text.
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
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/MentorAttachmentResponse'
 */
interface MulterFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export const lessonAttachController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const file = (req as unknown as { file?: MulterFile }).file;
  if (!file) {
    res
      .status(400)
      .json({ message: 'No file uploaded. Use multipart/form-data with a "file" field.' });
    return;
  }

  const moduleIndex = parseInt(req.params.moduleIndex as string, 10);
  const lessonIndex = parseInt(req.params.lessonIndex as string, 10);
  if (isNaN(moduleIndex) || isNaN(lessonIndex)) {
    res.status(400).json({ message: 'Invalid moduleIndex or lessonIndex' });
    return;
  }

  // Resolves slug-or-id → ownership check. Throws 404 if user doesn't
  // own the course, so the attachment can never land on a stranger's
  // chat doc.
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });

  const result = await attachToSession({
    userId,
    courseId: course._id.toString(),
    moduleIndex,
    lessonIndex,
    buffer: file.buffer,
    mimeType: file.mimetype,
    filename: file.originalname,
  });

  if (!result.ok) {
    const e = ERROR_MESSAGES[result.error];
    res.status(e.status).json({ message: e.message });
    return;
  }

  res.json({ data: result.data });
});
