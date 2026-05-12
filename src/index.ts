import dotenv from 'dotenv';
dotenv.config();
import 'tsconfig-paths/register';
// IMPORTANT: Sentry init MUST come before any other module that participates
// in instrumentation (express, http, mongoose). Importing this file runs
// Sentry.init synchronously as a side-effect.
import '@conf/sentry';
import 'colors';
import { createServer } from 'http';
import connectDB from '@conf/mongo';
import { API_URL, ENVIRONMENT, FRONTEND_URL, METRICS_TOKEN, PORT } from '@conf/env';
import { timingSafeEqual } from 'node:crypto';
import { errorHandler } from '@middleware/errorMiddleware';
import cors from 'cors';
import express from 'express';
import * as Sentry from '@sentry/node';
import { captureError } from '@lib/errorReporter';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mt from 'moment-timezone';
import swaggerSpec from '@middleware/swagger';
import swaggerUi from 'swagger-ui-express';
import { authRoutes } from '@routes/authRoutes';
import { billingRoutes } from '@routes/billingRoutes';
import { courseRoutes } from '@routes/courseRoutes';
import { gamificationRoutes } from '@routes/gamificationRoutes';
import { recallRoutes } from '@routes/recallRoutes';
import { productKbRoutes } from '@routes/productKbRoutes';
import { usageRoutes } from '@routes/usageRoutes';
import { devRoutes } from '@routes/devRoutes';
import { adminRoutes } from '@routes/adminRoutes';
import { stripeWebhookController } from '@controlers/billing';
import mongoose from 'mongoose';
import { getIO, initSocketIO } from '@lib/socket';
import { initJobSocketBridge } from '@lib/jobSocketBridge';
import { decodeAuthToken } from '@lib/auth';
import { bumpRateLimitHit, renderMetrics } from '@lib/metrics';
import { requestId } from '@middleware/requestId';
import { jobLimit, startStuckJobWatchdog, stopStuckJobWatchdog } from '@services/jobRunner';
import { getVersionInfo } from '@conf/versionInfo';
import { printGraphImages } from '@lib/ai/agents/printGraphImages';
import { lifecycleLog } from '@lib/loggers';

mt.tz.setDefault('UTC');

const app = express();

// Trust the first upstream hop (ALB / CloudFront / nginx) in production so
// `req.ip` reflects the real client IP. Without this, behind a CDN every
// user shares a single rate-limit bucket keyed on the proxy's IP, and the
// global 100 req/min limit can be tripped by six concurrent users.
//
// We deliberately leave it off in non-production: without a proxy in front,
// trusting `X-Forwarded-For` would let a client spoof any source IP they
// like. Set to `1` in prod because the stated deployment (Elastic Beanstalk
// behind ALB) has exactly one proxy hop.
if (ENVIRONMENT === 'production') {
  app.set('trust proxy', 1);
}

app.use(helmet());
app.use(
  cors({
    origin: ENVIRONMENT === 'production' ? FRONTEND_URL : '*',
    credentials: true,
  }),
);

// Stripe webhook is the ONLY route that requires the raw request body — the
// signature check runs against the exact bytes Stripe sent, and
// `express.json()` would consume + re-serialize them first, breaking
// verification. Mount the route here with its own `express.raw()` parser
// BEFORE the global JSON parser below.
app.post('/api/billing/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookController);

app.use(express.json({ limit: '1mb' }));

// Assign every request a correlation id. Mount before the rate limiter so
// even throttled 429s carry `X-Request-ID` on the response and appear in
// Sentry tagged — making abuse vs. legitimate-bug triage actually tractable.
app.use(requestId);

if (ENVIRONMENT !== 'development') {
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 100,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { message: 'Too many requests, please try again later' },
      validate: { keyGeneratorIpFallback: false },
      // Prefer the authenticated user id as the bucket key so multiple users
      // behind the same NAT don't contend. The limiter runs *before*
      // `protect`, so `req.userId` isn't populated yet — we peek at the
      // bearer ourselves via `decodeAuthToken`. On missing/invalid tokens
      // we fall back to IP (unauthenticated signup/signin stay IP-keyed,
      // as intended). Correct IP resolution depends on `trust proxy` being
      // set in production, otherwise every real client arrives as the CDN
      // edge IP and shares one bucket.
      keyGenerator: (req) => {
        const header = req.headers.authorization;
        if (header?.startsWith('Bearer ')) {
          const decoded = decodeAuthToken(header.slice(7));
          if (decoded?.id) return `u:${decoded.id}`;
        }
        return `i:${req.ip ?? 'anon'}`;
      },
      handler: (req, res, _next, options) => {
        // One-line observable signal so we can see who's hitting the limit
        // without turning on full request logging. `rate_limit_hit` is the
        // log-search anchor; the counter is scraped by `/metrics`. We quote
        // the limiter's own key (set by `keyGenerator` above) so log lines
        // and rate-limit buckets line up even when authenticated traffic
        // uses `u:<userId>` and anon uses `i:<ip>`.
        bumpRateLimitHit();
        const key = (req as unknown as { rateLimit?: { key?: string } }).rateLimit?.key ?? 'unknown';
        lifecycleLog.warn(`rate-limit:hit key=${key} ${req.method} ${req.originalUrl}`);
        res.status(options.statusCode).json(options.message);
      },
    }),
  );
}

app.get('/version', (_req, res) => {
  res.json(getVersionInfo());
});

// ── Health endpoints ─────────────────────────────────────
//
// `/live` — liveness probe. Answers "is the Node process alive?". Always
//   200 once the event loop is pumping. k8s / ECS use this to decide
//   whether to SIGKILL the container. It MUST NOT check dependencies:
//   returning 503 because Mongo is briefly unreachable would trigger a
//   restart, making the outage worse.
//
// `/ready` — readiness probe. Answers "should this instance receive
//   traffic right now?". Pings Mongo with a short timeout. If Mongo is
//   disconnected we return 503 so the load balancer pulls us out of
//   rotation, without killing the process.
//
// `/health` — kept for backward-compat with whatever is pointed at it
//   today; behaves like `/ready`.

app.get('/live', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const readinessHandler = async (_req: express.Request, res: express.Response) => {
  const started = Date.now();
  try {
    // readyState 1 = connected. Any other state means we shouldn't take traffic.
    if (mongoose.connection.readyState !== 1) {
      res.status(503).json({ status: 'not_ready', reason: 'mongo_not_connected' });
      return;
    }

    // Race the ping against a short timeout so a hung Mongo doesn't hang
    // the probe (LB would then mark us unhealthy on timeout anyway, but
    // we'd rather return 503 fast with a clear reason than stall).
    const db = mongoose.connection.db;
    if (!db) {
      res.status(503).json({ status: 'not_ready', reason: 'mongo_no_db' });
      return;
    }
    await Promise.race([
      db.admin().ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('mongo ping timeout')), 2_000)),
    ]);

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    res.status(503).json({
      status: 'not_ready',
      reason: err instanceof Error ? err.message : 'unknown',
    });
  }
};

app.get('/ready', readinessHandler);
app.get('/health', readinessHandler);

// Prometheus-compatible text-format endpoint. Aggregate gauges + counters
// only (no PII, no request bodies). Primary defence is still the network
// ACL (private ALB listener / security group). When `METRICS_TOKEN` is
// set, we require an `X-Metrics-Token` header as defence-in-depth — opt-in
// so the scraper config can be updated in a coordinated step. When unset,
// behaviour matches the pre-hardening default (open).
const checkMetricsToken = (req: express.Request): boolean => {
  if (!METRICS_TOKEN) return true;
  const provided = req.header('x-metrics-token');
  if (!provided) return false;
  // timingSafeEqual requires equal-length buffers; a length mismatch is
  // a non-match without leaking timing on the comparison itself.
  const a = Buffer.from(provided);
  const b = Buffer.from(METRICS_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

app.get('/metrics', (req, res) => {
  if (!checkMetricsToken(req)) {
    res.status(401).set('Content-Type', 'text/plain').send('Unauthorized');
    return;
  }
  const io = getIO();
  const body = renderMetrics({
    activeJobs: jobLimit.activeCount,
    pendingJobs: jobLimit.pendingCount,
    socketConnections: io.engine?.clientsCount ?? 0,
    mongoConnected: mongoose.connection.readyState === 1 ? 1 : 0,
  });
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(body);
});

app.use('/api/auth', authRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/course', courseRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/recall', recallRoutes);
app.use('/api/product-kb', productKbRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/admin', adminRoutes);

// Swagger UI + the raw `/swagger.json` spec are exposed in non-production
// only. In production the full route table + body schemas + errorCode
// catalog are hostile-recon material — an attacker gets the entire API
// contract for free. The spec stays available locally and on staging so
// the client codegen (`yarn codegen`) keeps working; production codegen
// must point at staging.
if (ENVIRONMENT !== 'production') {
  app.get('/swagger.json', (req, res) => {
    res.status(200).json(swaggerSpec);
  });

  app.use(
    '/swagger',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      explorer: true,
      customSiteTitle: 'Strive API',
      swaggerOptions: { filter: true },
    }),
  );

  // Browser-visible email template previews. Renders the same builders
  // production uses; never sends mail. Index at `/dev/email-preview`.
  app.use('/dev', devRoutes);
}

app.use((req, res, next) => {
  res.status(404);
  const error = new Error('Not found');
  next(error);
});

// `errorHandler` does its own Sentry capture (5xx only — see
// `errorMiddleware.ts`) so we deliberately do NOT mount
// `Sentry.setupExpressErrorHandler(app)`. The default integration captures
// every error reaching the chain, including Zod 400s and AppError 4xxs
// like INSUFFICIENT_CREDITS / EMAIL_NOT_VERIFIED — these are operational
// signals, not bugs, and they would dominate the event quota.
app.use(errorHandler);

const server = createServer(app);
initSocketIO(server);
initJobSocketBridge();

// Defer listen() until after DB connection + orphan-job cleanup. Accepting
// traffic before the reaper runs races with the reaper — a legitimate new
// job could be swept as a carcass. Moving the await inline here ensures
// traffic never sees a partially-initialized system.
connectDB().then(() => {
  server.listen(PORT, () => {
    lifecycleLog.info(`boot:ready url=${API_URL} env=${ENVIRONMENT} port=${PORT}`);
    // Watchdog must start AFTER the boot reaper has run (which is awaited
    // inside `connectDB`). Otherwise the watchdog would race the reaper for
    // the same `processing` rows. Starting it here also means tests can
    // import jobRunner without spawning a background timer.
    startStuckJobWatchdog();
    // printGraphImages();
  });
});

// ── Graceful shutdown ───────────────────────────────────

let shuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (shuttingDown) {
    lifecycleLog.error(`shutdown:double-signal signal=${signal} — forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;

  lifecycleLog.info(`shutdown:start signal=${signal}`);

  // Stop the watchdog timer so a slow shutdown doesn't get a final tick that
  // would race our drain logic.
  stopStuckJobWatchdog();

  // Hard safety net: if anything below hangs (a driver op, a socket, a
  // background flush), kill the process anyway. `unref()` so the timer
  // itself does not keep the loop alive.
  const hardKill = setTimeout(() => {
    lifecycleLog.error('shutdown:hard-timeout — killing process');
    process.exit(1);
  }, 130_000);
  hardKill.unref();

  // Stop accepting new connections AND drop idle keep-alives. Without the
  // second call, `server.close` waits on every idle keep-alive socket and
  // never resolves.
  server.close();
  server.closeAllConnections();

  // Disconnect socket.io clients before closing — `io.close()` alone waits
  // indefinitely for lingering websocket clients to hang up.
  const io = getIO();
  io.disconnectSockets(true);
  await new Promise<void>((resolve) => io.close(() => resolve()));

  const drainTimeout = 120_000; // Lesson generation takes 60-120s
  const start = Date.now();
  while (jobLimit.activeCount > 0 && Date.now() - start < drainTimeout) {
    lifecycleLog.info(`shutdown:drain active=${jobLimit.activeCount} elapsed=${Date.now() - start}ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (jobLimit.activeCount > 0) {
    lifecycleLog.error(`shutdown:drain-timeout active=${jobLimit.activeCount} — forcing exit`);
  }

  await mongoose.connection.close();
  lifecycleLog.info('mongo:disconnect');

  lifecycleLog.info(`shutdown:done signal=${signal} elapsed=${Date.now() - start}ms`);
  clearTimeout(hardKill);
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Process-level exception handlers ────────────────────
//
// `uncaughtException`: Node's exit semantics are unsafe-by-default — without
//   a handler the process crashes immediately with no Sentry capture and no
//   structured log line. WITH a handler, Node leaves the process running in
//   an undefined state, which is also bad. The right policy is "log + capture
//   + drain Sentry + exit non-zero so the orchestrator restarts a clean
//   process". The 2s drain budget matches Sentry.flush defaults.
//
// `unhandledRejection`: less severe — we log + capture but don't exit.
//   Promise rejections are usually recoverable (transient vendor outage,
//   SDK bug), and exiting on every one makes the service flap on flaky
//   networks. Set `--unhandled-rejections=strict` if a future Node version
//   behaviour changes that policy.
//
// Note `googleTtsService.ts:18-25` calls out a known landmine: google-gax's
// metadata-server probe rejects asynchronously and escapes user-level
// try/catch. This handler is the safety net for that and similar SDK quirks.
process.on('uncaughtException', (err: Error) => {
  lifecycleLog.error(`uncaughtException ${err?.stack ?? err}`);
  // captureError swallows internal Sentry SDK failures so we never
  // double-fault on the fatal path.
  captureError(err, {
    level: 'fatal',
    tags: { fatal: 'uncaughtException' },
    fingerprint: ['process', 'uncaughtException', err?.name ?? 'Error'],
  });
  Sentry.close(2_000)
    .catch(() => undefined)
    .finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  lifecycleLog.error(`unhandledRejection ${err.stack ?? err.message}`);
  captureError(err, {
    level: 'error',
    tags: { fatal: 'unhandledRejection' },
    fingerprint: ['process', 'unhandledRejection', err?.name ?? 'Error'],
  });
});
