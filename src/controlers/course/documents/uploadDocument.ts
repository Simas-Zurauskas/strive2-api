import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { createFileDocument, toClientSourceDocument } from '@services/sourceDocumentService';
import { AppError } from '@middleware/errorMiddleware';
import { assertDocumentsCourseMutable } from './shared';

/**
 * @swagger
 * /api/course/{courseId}/documents:
 *   post:
 *     summary: Upload a source document to a course-from-documents course
 *     description: >
 *       Multipart upload (field name `file`, max 50 MB). Accepted formats:
 *       pdf, docx, pptx, xlsx, odt, odp, ods, epub, txt, md, html, csv,
 *       png, jpg, webp, heic, mp3, m4a, wav. The server verifies the
 *       claimed type against the file bytes; the raw file is stored
 *       privately and processed later by the ingest job. Idempotent per
 *       course and content — re-uploading identical bytes returns the
 *       existing document instead of creating a duplicate. At most 10
 *       files per course.
 *
 *       Errors: 400 UNSUPPORTED_FILE_TYPE (bytes fail the allowlist),
 *       400 DOCUMENT_LIMIT_EXCEEDED (file cap, meta {limit, have}),
 *       413 DOCUMENT_LIMIT_EXCEEDED (file too large), 400 CUSTOM_ERROR
 *       (not a documents course / empty file), 409 TOO_MANY_ACTIVE_JOBS
 *       (a job is running on the course).
 *     tags: [Course]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema: { type: string }
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
 *                   $ref: '#/components/schemas/SourceDocument'
 */
interface MulterFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export const uploadDocumentController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const file = (req as unknown as { file?: MulterFile }).file;
  if (!file) {
    throw new AppError('No file uploaded. Use multipart/form-data with a "file" field.', {
      errorCode: 'CUSTOM_ERROR',
      statusCode: 400,
    });
  }

  // Slug-or-id → ownership check; a stranger's courseId never resolves.
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  assertDocumentsCourseMutable(course);

  const { document } = await createFileDocument({
    userId,
    courseId: course._id.toString(),
    buffer: file.buffer,
    filename: file.originalname,
  });

  res.status(200).json({ data: toClientSourceDocument(document) });
});
