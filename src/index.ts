import dotenv from 'dotenv';
dotenv.config();
import 'tsconfig-paths/register';
import 'colors';
import { createServer } from 'http';
import connectDB from '@conf/mongo';
import { API_URL, ENVIRONMENT, FRONTEND_URL, PORT } from '@conf/env';
import { errorHandler } from '@middleware/errorMiddleware';
import cors from 'cors';
import express from 'express';
import * as Sentry from '@sentry/node';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mt from 'moment-timezone';
import swaggerSpec from '@middleware/swagger';
import swaggerUi from 'swagger-ui-express';
import { authRoutes } from '@routes/authRoutes';
import { billingRoutes } from '@routes/billingRoutes';
import { courseRoutes } from '@routes/courseRoutes';
import { gamificationRoutes } from '@routes/gamificationRoutes';
import { insightRoutes } from '@routes/insightRoutes';
import { usageRoutes } from '@routes/usageRoutes';
import { stripeWebhookController } from '@controlers/billing';
import mongoose from 'mongoose';
import { getIO, initSocketIO } from '@lib/socket';
import { initJobSocketBridge } from '@lib/jobSocketBridge';
import { decodeAuthToken } from '@lib/auth';
import { bumpRateLimitHit, renderMetrics } from '@lib/metrics';
import { requestId } from '@middleware/requestId';
import { jobLimit } from '@services/jobRunner';
import { printGraphImages } from '@lib/ai/agents/printGraphImages';

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
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookController,
);

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
        console.warn(`[rate_limit_hit] key=${key} path=${req.method} ${req.originalUrl}`.yellow);
        res.status(options.statusCode).json(options.message);
      },
    }),
  );
}

app.get('/', (req, res) => {
  res.json({ service: 'Strive API', version: '1.0.0' });
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

// Prometheus-compatible text-format endpoint. No auth — metrics expose
// aggregate gauges and counters only (no PII, no request bodies). Restrict
// network access to internal scrapers via security groups / private ALB
// listener rules rather than application-layer auth; that way the scraper
// config stays simple and there's nothing to rotate.
app.get('/metrics', (_req, res) => {
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
app.use('/api/insight', insightRoutes);
app.use('/api/usage', usageRoutes);

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

app.use((req, res, next) => {
  res.status(404);
  const error = new Error('Not found');
  next(error);
});

Sentry.setupExpressErrorHandler(app);
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
    console.log(`Server running on: ${API_URL}`.bgCyan);
    printGraphImages();
  });
});

// ── Graceful shutdown ───────────────────────────────────

let shuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (shuttingDown) {
    console.log(`\n[Shutdown] ${signal} received again, forcing exit`.red);
    process.exit(1);
  }
  shuttingDown = true;

  console.log(`\n[Shutdown] ${signal} received, shutting down gracefully...`.yellow);

  // Hard safety net: if anything below hangs (a driver op, a socket, a
  // background flush), kill the process anyway. `unref()` so the timer
  // itself does not keep the loop alive.
  const hardKill = setTimeout(() => {
    console.log('[Shutdown] Hard timeout exceeded, killing process'.red);
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
    console.log(`[Shutdown] Waiting for ${jobLimit.activeCount} active job(s) to finish...`.yellow);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (jobLimit.activeCount > 0) {
    console.log(`[Shutdown] ${jobLimit.activeCount} job(s) still running after timeout, forcing exit`.red);
  }

  await mongoose.connection.close();
  console.log('[Shutdown] MongoDB connection closed'.cyan);

  clearTimeout(hardKill);
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
