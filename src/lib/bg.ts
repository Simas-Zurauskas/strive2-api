import * as Sentry from '@sentry/node';

/**
 * Canonical error handler for fire-and-forget background operations.
 *
 * Many side-effects in the codebase are intentionally detached from the
 * request path — gamification awards, cleanup sweeps after a failed stream,
 * streak-syncs during profile loads. We don't want those to fail the
 * primary response, but swallowing their errors with `.catch(() => {})`
 * meant every missed failure went unnoticed.
 *
 * Usage:
 *   gamificationService.onLessonComplete(userId, courseId)
 *     .catch(bgError('gamification.onLessonComplete'));
 *
 * The returned handler:
 *   - logs a single red line to stdout with the context label and message,
 *   - captures the error in Sentry tagged with `background_task: <context>`
 *     so dashboards can group recurring bg failures separately from
 *     request-path errors.
 *
 * It deliberately does NOT rethrow — callers rely on the fire-and-forget
 * contract.
 */
export const bgError = (context: string) => (err: unknown): void => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[bg:${context}] ${message}`.red);
  Sentry.captureException(err, { tags: { background_task: context } });
};
