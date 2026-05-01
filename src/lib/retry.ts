import { bumpWithRetry } from './metrics';

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Optional call-site label for observability. When set, every retry
   * attempt bumps the `with_retry_total{label}` counter and includes the
   * label in the log line so dashboards can slice retry storms by
   * source. Recommended pattern: `'<surface>:<operation>'` (e.g.
   * `'depth-previews'`, `'lesson:interactive'`, `'quiz:generate'`).
   *
   * Backwards-compatible — existing callers without a label still
   * retry as before; they just don't appear in the metric.
   */
  label?: string;
}

const DEFAULT_OPTIONS: Required<Pick<RetryOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const withRetry = async <T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> => {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_OPTIONS, ...options };
  const label = options?.label;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      if (attempt === maxRetries) break;

      const reason = error instanceof Error ? error.message : String(error);
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt) + Math.random() * 500, maxDelayMs);

      // Structured retry log + per-label metric. The metric only fires
      // when the caller opted in with a `label`; existing unlabelled
      // call sites still log without contributing to the counter (so
      // dashboards aren't polluted by anonymous retries).
      const labelTag = label ? ` label=${label}` : '';
      console.log(
        `[Retry]${labelTag} Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${Math.round(delay)}ms — ${reason}`.yellow,
      );
      if (label) bumpWithRetry(label);

      await sleep(delay);
    }
  }

  throw lastError;
};
