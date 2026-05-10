// Initialise Sentry. This file MUST be the very first import in
// `api/src/index.ts` (after dotenv) so the SDK's auto-instrumentation can
// patch http/express/mongoose hooks before they are required by anything
// else. If Sentry init runs late, `Sentry.captureException` still works but
// auto-traces, breadcrumbs, and Express error context are missing.
//
// SENTRY_DSN is required at boot in non-development environments (see
// env.ts). Without it the process refuses to start — every
// `captureException` call would otherwise be a silent no-op, which is the
// failure mode we want to make impossible. In development Sentry is
// skipped entirely so local runs don't ship events to the prod project.

import * as Sentry from '@sentry/node';
import { ENVIRONMENT, SENTRY_DSN } from './env';
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

// Parse `SENTRY_TRACES_SAMPLE_RATE` from env. Allows ops to tune sampling
// per environment without redeploying. Falls back to 0 (off) on any parse
// error or absent env so a typo never accidentally bills 100% of traffic.
const parseSampleRate = (raw: string | undefined, env: string): number => {
  if (env === 'test') return 0;
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0;
  return n;
};

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

if (ENVIRONMENT === 'development') {
  lifecycleLog.info('sentry:disabled environment=development');
} else {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: ENVIRONMENT,
    // Tracing samples are expensive (one full transaction per sampled event).
    // Default to off everywhere; opt-in via env so production can be cranked
    // up to 0.05 etc. once event quota budget is approved without a code
    // change. Tests stay at 0 always (no point sampling unit-test runs).
    tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, ENVIRONMENT),
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
}
