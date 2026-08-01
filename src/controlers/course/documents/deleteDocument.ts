import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { deleteSourceDocument } from '@services/sourceDocumentService';
import { AppError } from '@middleware/errorMiddleware';
import { assertDocumentsCourseMutable } from './shared';

/**
 * @swagger
 * /api/course/{courseId}/documents/{documentId}:
 *   delete:
 *     summary: Delete a source document from a course
 *     description: >
 *       Removes the document row and its stored raw file. Owner-scoped —
 *       a documentId belonging to another user's course returns 404.
 *
 *       Errors: 404 NOT_FOUND (unknown document), 400 CUSTOM_ERROR (not
 *       a documents course), 409 TOO_MANY_ACTIVE_JOBS (a job is running
 *       on the course).
 *     tags: [Course]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: documentId
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
 *                   type: object
 *                   required: [deleted]
 *                   properties:
 *                     deleted:
 *                       type: boolean
 */
export const deleteDocumentController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  assertDocumentsCourseMutable(course);

  const deleted = await deleteSourceDocument({
    courseId: course._id.toString(),
    documentId: req.params.documentId as string,
  });

  if (!deleted) {
    throw new AppError('Document not found.', { errorCode: 'NOT_FOUND', statusCode: 404 });
  }

  res.status(200).json({ data: { deleted: true } });
});
