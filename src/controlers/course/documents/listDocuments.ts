import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { listCourseDocuments, toClientSourceDocument } from '@services/sourceDocumentService';

/**
 * @swagger
 * /api/course/{courseId}/documents:
 *   get:
 *     summary: List the source documents of a course
 *     description: >
 *       Returns the course's source documents (uploaded files and article
 *       URLs), oldest first. The set is bounded by the per-course caps
 *       (10 files + 10 URLs), so the list is complete — no pagination.
 *       A goal-based course returns an empty list. The response contains
 *       metadata only — never storage keys, hashes, or extracted content.
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
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SourceDocument'
 */
export const listDocumentsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });

  const documents = await listCourseDocuments({ courseId: course._id.toString() });

  res.status(200).json({ data: documents.map(toClientSourceDocument) });
});
