/**
 * Load a course the caller owns, or answer 404.
 *
 * `getUserCourseLean` throws a bare `Error('Course not found')` with no
 * `statusCode` (`services/courseDbService.ts:112-114`), and `errorHandler`
 * falls back to **500** when neither `res.statusCode` nor `err.statusCode`
 * is set (`middleware/errorMiddleware.ts:97-98`) — which also means every
 * such miss is captured to Sentry as a server error.
 *
 * That is pre-existing behaviour across the other course endpoints and
 * changing the shared helper would alter their responses, so it is left
 * alone. These export routes handle it locally instead: a course you do not
 * own is a 404, not a 500, and does not page anyone.
 */

import type { Response } from 'express';
import { getUserCourseLean } from '@services/courseDbService';

type LeanCourse = Awaited<ReturnType<typeof getUserCourseLean>>;

/**
 * The exact string `getUserCourseLean` throws when the lookup misses
 * (`services/courseDbService.ts:113`). Matching on it is unlovely, but the
 * alternative — treating every throw as "not found" — turns a Mongo outage
 * into a silent 404 with no Sentry event.
 */
const NOT_FOUND_MESSAGE = 'Course not found';

export const loadOwnedCourse = async ({
  userId,
  courseId,
  res,
}: {
  userId: string;
  courseId: string;
  res: Response;
}): Promise<LeanCourse | null> => {
  try {
    return await getUserCourseLean({ userId, courseId });
  } catch (e) {
    // Only the helper's own "not found" throw becomes a 404. A driver or
    // connection failure must NOT be reported to the user as a missing
    // course and hidden from Sentry — it is rethrown so `errorHandler`
    // gives it the 500 it deserves.
    const message = e instanceof Error ? e.message : '';
    if (message !== NOT_FOUND_MESSAGE) throw e;
    res.status(404).json({ message: 'Course not found' });
    return null;
  }
};
