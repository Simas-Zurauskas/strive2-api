import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/node';

// Accept an inbound correlation id only if it looks safe — bounded length,
// alphanumerics + [-_] only. Keeps log-injection (e.g., attacker sending
// `X-Request-ID: foo\n[ERROR] …`) off the table without losing the ability
// to thread a client-supplied id through a single-page-app → API chain.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Assigns a correlation id to every request.
 *
 * - Accepts a caller-supplied `X-Request-ID` if it passes `SAFE_ID`.
 * - Otherwise generates a UUIDv4.
 * - Mirrors the id back on the response as `X-Request-ID` so clients can
 *   quote it in bug reports.
 * - Pipes it into the Sentry scope so every captureException has
 *   `tags.request_id` without controllers needing to remember.
 *
 * Mount this BEFORE route mounts and BEFORE the Sentry request handler so
 * the scope tag is set by the time a controller throws.
 */
export const requestId = (req: Request, res: Response, next: NextFunction) => {
  const incoming = req.get('X-Request-ID');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();

  req.id = id;
  res.setHeader('X-Request-ID', id);

  // Scope is per-request in Sentry's Node SDK; tagging here means every
  // error logged later in this request has the correlation id attached.
  Sentry.getCurrentScope().setTag('request_id', id);

  next();
};
