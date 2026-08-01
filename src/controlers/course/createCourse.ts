import asyncHandler from 'express-async-handler';
import { createCourseSchema } from './validation';
import { createCourse } from '@services/courseDbService';
import CourseModel from '@models/CourseModel';
import { AppError } from '@middleware/errorMiddleware';
import { DOCUMENTS_PLACEHOLDER_GOAL, MAX_DOC_COURSES_PER_USER_PER_DAY } from '@lib/constants';

/**
 * @swagger
 * /api/course:
 *   post:
 *     summary: Create a new course
 *     description: >
 *       Creates a course from a typed goal (the classic flow — `goal`
 *       required), or, with `source: documents`, creates the shell for a
 *       course-from-documents flow: `goal` becomes optional and the
 *       server persists a placeholder until the source analysis suggests
 *       one. Omitting `source` behaves exactly as before. At most 5
 *       document courses per user per day (400 DOCUMENT_LIMIT_EXCEEDED,
 *       meta {limit, have}); goal-based creation is not capped.
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               goal:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 500
 *                 description: Required unless source is documents.
 *               source:
 *                 $ref: '#/components/schemas/CourseSource'
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
 *                   required: [courseId]
 *                   properties:
 *                     courseId:
 *                       type: string
 */
export const createCourseController = asyncHandler(async (req, res) => {
  const { goal, source } = createCourseSchema.parse(req.body);

  // A9: ≤5 doc-courses / user / day. The free ingest-and-assess pass makes
  // each documents course a bundle of free vendor spend (extraction,
  // moderation, assessment, embeddings), so course creation itself is the
  // choke point — the per-course caps (files/URLs/pages/ingest-runs) bound
  // a single course, this bounds how many such courses one user can mint.
  // Count-then-insert is APPROXIMATE under concurrency (two racing creates
  // may both pass), same as the ingest-run cap — acceptable for an abuse
  // bound. Goal-based creation is untouched.
  if (source === 'documents') {
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const docCoursesToday = await CourseModel.countDocuments({
      userId: req.userId!,
      source: 'documents',
      createdAt: { $gte: windowStart },
    });
    if (docCoursesToday >= MAX_DOC_COURSES_PER_USER_PER_DAY) {
      throw new AppError(
        `You have already created ${docCoursesToday} document courses in the last 24 hours (max ${MAX_DOC_COURSES_PER_USER_PER_DAY}/day). Try again later.`,
        {
          errorCode: 'DOCUMENT_LIMIT_EXCEEDED',
          statusCode: 400,
          meta: { limit: MAX_DOC_COURSES_PER_USER_PER_DAY, have: docCoursesToday, windowDescription: '24 hours' },
        },
      );
    }
  }

  const course = await createCourse({
    userId: req.userId!,
    // The schema guarantees goal is present unless source === 'documents'.
    goal: goal ?? DOCUMENTS_PLACEHOLDER_GOAL,
    ...(source ? { source } : {}),
  });

  res.status(200).json({ data: { courseId: course._id.toString() } });
});
