// Initialise Sentry. This file MUST be the very first import in
// `api/src/index.ts` (after dotenv) so the SDK's auto-instrumentation can
// patch http/express/mongoose hooks before they are required by anything
// else. If Sentry init runs late, `Sentry.captureException` still works but
// auto-traces, breadcrumbs, and Express error context are missing.
//
// SENTRY_DSN is required at boot (see env.ts:55). Without it the process
// refuses to start — every `captureException` call would otherwise be a
// silent no-op, which is the failure mode we want to make impossible.

import * as Sentry from '@sentry/node';
import { ENVIRONMENT, RELEASE_SHA, SENTRY_DSN } from './env';
import { lifecycleLog } from '@lib/loggers';

const SENSITIVE_KEYS = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'confirmPassword',
  'token',
  'authorization',
  'cookie',
  'creditCard',
  'cardNumber',
  'cvv',
  'stripeSecretKey',
]);

const scrubObject = (input: unknown, depth = 0): unknown => {
  if (depth > 4) return '[truncated:depth]';
  if (input == null) return input;
  if (Array.isArray(input)) return input.map((v) => scrubObject(v, depth + 1));
  if (typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = scrubObject(value, depth + 1);
  }
  return out;
};

Sentry.init({
  dsn: SENTRY_DSN,
  environment: ENVIRONMENT,
  release: RELEASE_SHA,
  // Default 1.0 captures every error; that's fine for now. Tracing is
  // expensive enough that we leave it disabled until we have a use for it.
  tracesSampleRate: 0,
  // Don't auto-capture request data (bodies, headers, cookies). We attach
  // explicit, scrubbed `extra` fields at the callsites we care about.
  sendDefaultPii: false,
  beforeSend(event) {
    if (event.request) {
      // Strip cookies + auth headers in case the express integration grabbed them.
      delete event.request.cookies;
      if (event.request.headers) {
        const filtered: Record<string, string> = {};
        for (const [k, v] of Object.entries(event.request.headers)) {
          if (k.toLowerCase() === 'authorization') continue;
          if (k.toLowerCase() === 'cookie') continue;
          if (typeof v === 'string') filtered[k] = v;
        }
        event.request.headers = filtered;
      }
      // Body: scrub known-sensitive keys; leave structure for debugging.
      if (event.request.data) {
        event.request.data = scrubObject(event.request.data);
      }
    }
    if (event.extra) {
      event.extra = scrubObject(event.extra) as typeof event.extra;
    }
    return event;
  },
});

lifecycleLog.info(`sentry:ready environment=${ENVIRONMENT}`);
