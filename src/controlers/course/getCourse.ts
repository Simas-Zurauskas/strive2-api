import asyncHandler from 'express-async-handler';
import { getUserCourseLean, omitServerOnlyCourseFields } from '@services/courseDbService';
import { ensureDepthPreviewsScope } from '@services/courseService';

/**
 * @swagger
 * /api/course/{id}:
 *   get:
 *     summary: Get a single course by ID
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *                   $ref: '#/components/schemas/Course'
 */
export const getCourseController = asyncHandler(async (req, res) => {
  const course = await getUserCourseLean({ userId: req.userId!, courseId: req.params.id as string });

  // Backfill per-tier scope ranges on `depthPreviews` for courses persisted
  // before that field was added. No-op on already-enriched documents.
  const enriched = ensureDepthPreviewsScope(course);

  res.status(200).json({ data: omitServerOnlyCourseFields(enriched) });
});
