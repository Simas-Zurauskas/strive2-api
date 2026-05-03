import type { RequestHandler } from 'express';
import rateLimit, { Options } from 'express-rate-limit';
import { ENVIRONMENT } from '@conf/env';
import { bumpRateLimitHit } from '@lib/metrics';
import { lifecycleLog } from '@lib/loggers';

/**
 * Per-email rate-limit middleware. Distinct from the IP-keyed `authLimiter`
 * in `authRoutes.ts` — we want per-email limits on flows that an attacker
 * can trigger against a specific victim from many different IPs:
 *   - /signin: credential-stuffing one account from a botnet
 *   - /forgot-password: spamming reset emails to a victim
 *   - /resend-verification: same
 *
 * Identifying key: req.body.email, lowercased and trimmed. Requests without
 * an email body field fall through to the next handler — the IP-keyed
 * limiter still gates them. Disabled in `development` to keep dev DX flat.
 *
 * Trade-off vs server-side state: we use express-rate-limit's in-memory
 * store, which is per-process. With single-instance deploy (per CLAUDE.md)
 * this is correct. A multi-instance deploy needs a Redis store; the same
 * caveat applies to the global limiter.
 */
export const perEmailRateLimit = ({
  windowMs,
  limit,
  errorCode,
  errorMessage,
}: {
  windowMs: number;
  limit: number;
  errorCode: string;
  errorMessage: string;
}): RequestHandler => {
  if (ENVIRONMENT === 'development') {
    // Pass-through middleware in dev so the local 'forgot password' loop
    // doesn't get blocked between iterations.
    return (_req, _res, next) => next();
  }

  const opts: Partial<Options> = {
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: errorMessage, errorCode },
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => {
      const body = req.body as { email?: unknown } | undefined;
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : null;
      // Bucket by IP when no email is present so the request still falls
      // under SOME limit. Use a distinct key prefix from the IP-keyed
      // limiter so the two buckets don't collide.
      return email ? `e:${email}` : `pe-fallback:${req.ip ?? 'anon'}`;
    },
    skip: (req) => {
      // Only apply when there's actually an email in the body. Routes that
      // don't have an email param wouldn't make sense to per-email limit.
      const body = req.body as { email?: unknown } | undefined;
      return typeof body?.email !== 'string';
    },
    handler: (req, res, _next, options) => {
      bumpRateLimitHit();
      const body = req.body as { email?: unknown } | undefined;
      const email = typeof body?.email === 'string' ? body.email : '?';
      lifecycleLog.warn(`rate-limit:hit-per-email email=${email} ${req.method} ${req.originalUrl}`);
      res.status(options.statusCode).json(options.message);
    },
  };

  return rateLimit(opts);
};
