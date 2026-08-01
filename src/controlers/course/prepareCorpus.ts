import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import { submitJob } from '@services/jobRunner';
import { AppError } from '@middleware/errorMiddleware';

/**
 * @swagger
 * /api/course/{courseId}/prepare-corpus:
 *   post:
 *     summary: Start the debited corpus-preparation job for a documents course
 *     description: >
 *       Submits a `prepare_corpus` job that completes the paid extraction
 *       the free ingest pass deferred — full vision escalation of scanned
 *       pages beyond the triage sample and full audio transcription beyond
 *       the free window — then moderates all newly extracted text,
 *       re-indexes the affected documents and refreshes the source digest.
 *       Debited like generation jobs (real accumulated spend on success;
 *       a failed run charges nothing). Idempotent: with no outstanding
 *       work the job completes quickly as a no-op. The client detects
 *       outstanding work from GET /documents:
 *       `scannedPageCount > escalatedPages.length` or
 *       `transcribedSec < audioDurationSec`. Progress streams as
 *       `document_status` events on the job:progress socket channel.
 *
 *       Errors: 400 CUSTOM_ERROR (not a documents course),
 *       400 CONTENT_REJECTED via the job-failure socket payload (moderation
 *       hit in newly extracted content, meta {rejected, failed, prepared}),
 *       402 INSUFFICIENT_CREDITS (pre-flight gate),
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
export const prepareCorpusController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });

  if (course.source !== 'documents') {
    throw new AppError('This course was not created from documents, so there is no corpus to prepare.', {
      errorCode: 'CUSTOM_ERROR',
      statusCode: 400,
    });
  }

  // Deliberately no outstanding-work pre-check here: the job body is
  // idempotent and completes as a fast no-op when nothing is outstanding,
  // which keeps the client flow simple (always safe to call before
  // generate-structure). The per-course mutex inside submitJob serializes
  // this against every other job on the course.
  const jobId = await submitJob({
    userId,
    courseId: course._id.toString(),
    type: 'prepare_corpus',
  });

  res.status(202).json({ data: { jobId } });
});
