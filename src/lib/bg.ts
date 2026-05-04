import { lifecycleLog } from '@lib/loggers';
import { captureError } from '@lib/errorReporter';

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
 *   - logs one error line on `lifecycleLog` (cross-cutting fire-and-forget
 *     channel — not bound to a single domain), tagged with the context label,
 *   - reports to Sentry via `captureError` so the event picks up the
 *     active usageContext (userId/plan/jobId), gets tagged
 *     `background_task: <context>` for dashboard grouping, and is
 *     fingerprinted by `context` so a flapping background task collapses
 *     into a single Sentry issue instead of N copies.
 *
 * It deliberately does NOT rethrow — callers rely on the fire-and-forget
 * contract.
 */
export const bgError = (context: string) => (err: unknown): void => {
  const message = err instanceof Error ? err.message : String(err);
  lifecycleLog.error(`bg:${context} ${message}`);
  captureError(err, {
    tags: { background_task: context },
    fingerprint: ['bg', context],
  });
};
