import { AppError } from '@middleware/errorMiddleware';
import { LeanCourse } from '@services/courseDbService';

/**
 * Mutation gate for the source-document endpoints (upload / add-url /
 * delete). Reads (list) are not gated — a goal-based course simply lists
 * an empty set.
 *
 *  - Only `source: 'documents'` courses have a managed source set; on a
 *    goal-based course the mutation is a client bug → 400.
 *  - While any job runs on the course (ingest, prepare_corpus, or a
 *    generation job), the document set is frozen — an ingest job reading
 *    documents mid-mutation would process a set the user no longer
 *    intends. 409 with the same code/semantics as the existing
 *    "job already running" concurrency errors so the client's existing
 *    handling applies.
 */
export const assertDocumentsCourseMutable = (course: LeanCourse): void => {
  if (course.source !== 'documents') {
    throw new AppError(
      'This course was not created from documents, so it has no source documents to manage.',
      { errorCode: 'CUSTOM_ERROR', statusCode: 400 },
    );
  }
  if (course.activeJobId) {
    throw new AppError('A job is already running for this course. Please wait for it to complete.', {
      errorCode: 'TOO_MANY_ACTIVE_JOBS',
      statusCode: 409,
      meta: { active: 1, limit: 1 },
    });
  }
};
