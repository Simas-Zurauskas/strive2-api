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

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt) + Math.random() * 500, maxDelayMs);

      // Per-label metric records every retry — `bumpWithRetry(label)` is the
      // durable record dashboards slice on. Final-attempt failure rethrows
      // and the caller's catch logs via its own domain logger, so a stdout
      // line for each transient retry would just be noise.
      if (label) bumpWithRetry(label);

      await sleep(delay);
    }
  }

  throw lastError;
};
