/**
 * Canonical Sentry capture entry point. Every error or warning that should
 * surface in Sentry goes through `captureError` / `captureWarning` so we get
 * a consistent shape across the codebase: auto-enriched user/plan/job tags
 * pulled from `usageContext`, the running request id from the active scope,
 * caller-supplied tags merged on top, and 4xx client errors filtered out
 * before they ever leave Node.
 *
 * Why a wrapper rather than `Sentry.captureException` directly:
 *   - Without it, every caller invents its own tag/extra shape — some
 *     remember `userId`, most don't, and `plan`/`jobId` is rarely attached.
 *     Dashboards then can't slice by user or job because the data isn't
 *     uniformly present.
 *   - The default Express integration captures every error reaching the
 *     handler, including Zod 400s and AppError 4xx (insufficient credits,
 *     unverified email). Those are operational signals, not bugs, and they
 *     burn the Sentry event quota. The `isOperationalClientError` gate
 *     drops them at the boundary.
 *   - Retried failures (a stuck job watchdog firing N times, a flapping
 *     bgError context) get fingerprinted by caller so Sentry collapses
 *     them into a single issue instead of N copies.
 *
 * The `extra` field is recursively scrubbed by `conf/sentry.ts:beforeSend`
 * so callers can pass `metadata: job.metadata` without manually filtering
 * sensitive keys.
 */

import * as Sentry from '@sentry/node';
import { getUsageContext } from './usageContext';

type SeverityLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug' | 'log';

type Primitive = string | number | boolean;

export interface CaptureOpts {
  tags?: Record<string, Primitive>;
  extra?: Record<string, unknown>;
  /** Override severity. Defaults to 'error' for `captureError`. */
  level?: SeverityLevel;
  /**
   * Sentry fingerprint — collapses retries / repeat failures into one
   * issue. Pass a stable identity like `['stripe-webhook', eventType]`
   * or `['job-failure', jobType]`. If omitted, Sentry's default grouping
   * (by stacktrace) applies.
   */
  fingerprint?: string[];
}

/**
 * Operational client errors (Zod 400, AppError 4xx, InsufficientCreditsError
 * 402, MaxConcurrentJobsError 409, etc.) are NOT bugs — they're expected
 * states the API surfaces to the client. Reporting them to Sentry is noise
 * that drowns out real errors and burns the event quota.
 *
 * The 5xx range still flows through (server bugs, unexpected exceptions)
 * along with anything that doesn't carry a `statusCode` — the latter
 * defaults to 500 in `errorMiddleware` and is the standard "unhandled" path.
 */
export const isOperationalClientError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  if ((err as { name?: string }).name === 'ZodError') return true;
  const status = (err as { statusCode?: number }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
};

const enrichScopeFromUsageContext = (scope: Sentry.Scope): void => {
  const ctx = getUsageContext();
  if (!ctx) return;
  scope.setUser({ id: ctx.userId });
  scope.setTag('source', ctx.source);
  if (ctx.plan) scope.setTag('plan', ctx.plan);
  if (ctx.subscriptionStatus) scope.setTag('subscription_status', ctx.subscriptionStatus);
  if (ctx.jobId) scope.setTag('job_id', ctx.jobId);
  if (ctx.courseId) scope.setTag('course_id', ctx.courseId);
  if (typeof ctx.moduleIndex === 'number') scope.setExtra('moduleIndex', ctx.moduleIndex);
  if (typeof ctx.lessonIndex === 'number') scope.setExtra('lessonIndex', ctx.lessonIndex);
};

const applyOpts = (scope: Sentry.Scope, opts: CaptureOpts, defaultLevel: SeverityLevel): void => {
  enrichScopeFromUsageContext(scope);
  scope.setLevel(opts.level ?? defaultLevel);
  if (opts.tags) {
    for (const [k, v] of Object.entries(opts.tags)) scope.setTag(k, v);
  }
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) scope.setExtra(k, v);
  }
  if (opts.fingerprint?.length) scope.setFingerprint(opts.fingerprint);
};

/**
 * Capture an exception. 4xx operational errors are dropped silently — the
 * `errorMiddleware` is still responsible for shaping the HTTP response;
 * Sentry just doesn't need to know.
 *
 * Never throws — wrapping the SDK call in try/catch keeps a misconfigured
 * Sentry from cascading into a request handler crash.
 */
export const captureError = (err: unknown, opts: CaptureOpts = {}): void => {
  if (isOperationalClientError(err)) return;
  try {
    Sentry.withScope((scope) => {
      applyOpts(scope, opts, 'error');
      Sentry.captureException(err);
    });
  } catch {
    // Sentry SDK failures are never user-visible.
  }
};

/**
 * Capture a non-exceptional but noteworthy event (a degraded fallback, a
 * retry-exhausted attempt, a code-mismatch on a security action). Recorded
 * at `warning` level by default; pass `level: 'info'` for lower-severity
 * signal.
 */
export const captureWarning = (message: string, opts: Omit<CaptureOpts, 'level'> & { level?: 'warning' | 'info' } = {}): void => {
  try {
    Sentry.withScope((scope) => {
      applyOpts(scope, opts, opts.level ?? 'warning');
      Sentry.captureMessage(message);
    });
  } catch {
    // Sentry SDK failures are never user-visible.
  }
};

/**
 * Drop a breadcrumb to enrich the trail of the next captured event in this
 * scope. Cheap (no network call); use liberally at major lifecycle points
 * (job-start, agent-invoke, credit-debit) so post-mortems have context.
 */
export const addBreadcrumb = (breadcrumb: {
  category?: string;
  message?: string;
  level?: SeverityLevel;
  data?: Record<string, unknown>;
}): void => {
  try {
    Sentry.addBreadcrumb({
      timestamp: Date.now() / 1000,
      ...breadcrumb,
    });
  } catch {
    // ignored — breadcrumbs are best-effort
  }
};

/**
 * Re-export of `Sentry.setUser` for the small number of callers that need
 * to attach user identity outside of `usageContext` propagation (e.g. the
 * authentication middleware that runs before `usageContext` opens).
 */
export const setSentryUser = (userId: string | null): void => {
  try {
    if (userId) Sentry.getCurrentScope().setUser({ id: userId });
    else Sentry.getCurrentScope().setUser(null);
  } catch {
    // ignored
  }
};
