import asyncHandler from 'express-async-handler';
import JobModel from '@models/JobModel';
import SourceDocumentModel from '@models/SourceDocumentModel';
import { getUserCourseLean } from '@services/courseDbService';
import { submitJob } from '@services/jobRunner';
import { INGESTABLE_STATUSES, MAX_INGEST_RUNS_PER_DAY } from '@services/documentIngestService';
import { AppError } from '@middleware/errorMiddleware';

/**
 * @swagger
 * /api/course/{courseId}/documents/ingest:
 *   post:
 *     summary: Start the free ingest-and-assess job for a documents course
 *     description: >
 *       Submits an `ingest_documents` job that extracts, moderates,
 *       assesses, chunks and embeds every pending source document
 *       (status uploaded, failed, or stale parsing). Free by policy —
 *       no credits are debited. Progress streams as `document_status`
 *       events on the job:progress socket channel; completion lands the
 *       coarse SourceAnalysis on the course. At most 3 ingest runs per
 *       course per day.
 *
 *       Errors: 400 CUSTOM_ERROR (not a documents course / nothing to
 *       ingest), 400 DOCUMENT_LIMIT_EXCEEDED (daily run cap, meta
 *       {limit, have}), 402 INSUFFICIENT_CREDITS (pre-flight gate),
 *       409 TOO_MANY_ACTIVE_JOBS / job-already-running (per-course mutex).
 *     tags: [Course]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       202:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 *                   required: [jobId]
 *                   properties:
 *                     jobId:
 *                       type: string
 */
export const ingestDocumentsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });

  if (course.source !== 'documents') {
    throw new AppError('This course was not created from documents, so there is nothing to ingest.', {
      errorCode: 'CUSTOM_ERROR',
      statusCode: 400,
    });
  }

  // ≥1 doc must be waiting. `parsing` counts: a doc stranded there by a
  // crashed run (the boot reaper fails the JOB but not the doc rows) must
  // stay re-ingestable — the job's load filter uses the same set.
  const ingestable = await SourceDocumentModel.countDocuments({
    courseId: course._id,
    status: { $in: INGESTABLE_STATUSES },
  });
  if (ingestable === 0) {
    throw new AppError('No documents are waiting to be processed. Upload a document or URL first.', {
      errorCode: 'CUSTOM_ERROR',
      statusCode: 400,
    });
  }

  // A9: ≤3 ingest runs / course / day, counted over Job rows created in
  // the trailing 24h. APPROXIMATE by design: the Job TTL reaps rows 24h
  // after completion, so a row can only age out of Mongo after it has also
  // aged out of this window — the count may UNDER-count (letting an extra
  // run through after an outage-length gap) but can never over-block.
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const runsToday = await JobModel.countDocuments({
    courseId: course._id,
    type: 'ingest_documents',
    createdAt: { $gte: windowStart },
  });
  if (runsToday >= MAX_INGEST_RUNS_PER_DAY) {
    throw new AppError(
      `This course has already run ${runsToday} ingests in the last 24 hours (max ${MAX_INGEST_RUNS_PER_DAY}/day). Try again later.`,
      {
        errorCode: 'DOCUMENT_LIMIT_EXCEEDED',
        statusCode: 400,
        meta: { limit: MAX_INGEST_RUNS_PER_DAY, have: runsToday, windowDescription: '24 hours' },
      },
    );
  }

  // The per-course mutex inside submitJob serializes this against every
  // other job on the course — no extra locking here.
  const jobId = await submitJob({
    userId,
    courseId: course._id.toString(),
    type: 'ingest_documents',
  });

  res.status(202).json({ data: { jobId } });
});
