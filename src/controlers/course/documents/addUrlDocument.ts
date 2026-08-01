import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import { getUserCourseLean } from '@services/courseDbService';
import { createUrlDocument, toClientSourceDocument } from '@services/sourceDocumentService';
import { assertDocumentsCourseMutable } from './shared';

const addUrlDocumentSchema = z.object({
  url: z.string().min(1, 'URL is required').max(2048, 'URL must be at most 2048 characters'),
});

/**
 * @swagger
 * /api/course/{courseId}/documents/url:
 *   post:
 *     summary: Add a public article URL as a course source document
 *     description: >
 *       Registers a public http(s) article URL as a source document. The
 *       URL is validated only (scheme, public-host shape) — nothing is
 *       fetched by this endpoint; the ingest job fetches a snapshot later
 *       via an external reader. Local, private-network, IP-literal and
 *       credentialed URLs are rejected. Idempotent per course and URL —
 *       re-adding the same URL returns the existing document. At most 10
 *       URLs per course.
 *
 *       Errors: 400 CUSTOM_ERROR (invalid or non-public URL, not a
 *       documents course), 400 DOCUMENT_LIMIT_EXCEEDED (URL cap, meta
 *       {limit, have}), 409 TOO_MANY_ACTIVE_JOBS (a job is running on
 *       the course).
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
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 2048
 *                 description: Public http(s) article URL.
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
export const addUrlDocumentController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { url } = addUrlDocumentSchema.parse(req.body);

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  assertDocumentsCourseMutable(course);

  const { document } = await createUrlDocument({
    userId,
    courseId: course._id.toString(),
    url,
  });

  res.status(200).json({ data: toClientSourceDocument(document) });
});
