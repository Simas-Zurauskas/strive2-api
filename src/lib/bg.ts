import * as Sentry from '@sentry/node';

/**
 * Log-color convention across api/src (uses the `colors` package's
 * String.prototype extensions):
 *   .red    — genuine terminal error: thrown, 5xx, process exit, or a
 *             fire-and-forget failure captured to Sentry. Paired with
 *             `console.error` or `bgError(...)`.
 *   .yellow — recoverable warning: retry fired, soft-fail, degraded output
 *             shipped, feature disabled, cap exceeded but proceeding.
 *             Paired with `console.warn`.
 *
 * If a caller catches and continues (ships partial/fallback output), the
 * log is yellow even when it describes a failure. Red is reserved for
 * paths the system cannot recover from — it should track 1:1 with things
 * Sentry cares about.
 */

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
 *   gamificationService.onLessonComplete({ userId, courseId })
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
