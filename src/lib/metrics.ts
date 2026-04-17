/**
 * Tiny in-process metrics store.
 *
 * Deliberately zero-dep — we don't need prom-client or OTel for the handful
 * of counters and gauges this service exposes, and pulling in a big metrics
 * library for five data points is overkill. The `/metrics` endpoint in
 * `index.ts` reads from this module and renders a Prometheus text-format
 * response a scraper can consume as-is.
 *
 * Everything lives in module-scoped state, so values reset on process
 * restart. That's fine for gauges (they're reobserved immediately) and
 * acceptable for counters (rate derivatives are what dashboards care about
 * and they tolerate resets via Prometheus' `rate()` semantics).
 */

import { monitorEventLoopDelay } from 'perf_hooks';

// ── Counters (monotonically increasing) ────────────────────

/** Rate-limit handler fired — one increment per 429 emitted. */
export let rateLimitHits = 0;

/** Server-Sent Events lesson streams started. */
export let sseStreamsStarted = 0;

/** SSE lesson streams that ended (success OR error). */
export let sseStreamsEnded = 0;

export const bumpRateLimitHit = () => {
  rateLimitHits += 1;
};

export const bumpSseStreamStarted = () => {
  sseStreamsStarted += 1;
};

export const bumpSseStreamEnded = () => {
  sseStreamsEnded += 1;
};

// ── Event loop lag monitor ──────────────────────────────────
// `monitorEventLoopDelay` runs inside libuv and costs effectively nothing.
// Call `reset()` after each scrape so p99 reflects the *recent* window
// instead of since-boot (which is useless for alerting after a few hours).
// Resolution of 10ms is plenty — we care about multi-ms lag, not microseconds.

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

export const readEventLoopLag = (): { p50Ms: number; p99Ms: number } => {
  // Histogram percentile returns nanoseconds.
  const p50Ns = loopDelay.percentile(50);
  const p99Ns = loopDelay.percentile(99);
  // Reset so the next scrape measures a fresh interval. Counters outside
  // the histogram remain monotonic.
  loopDelay.reset();
  return {
    p50Ms: Number.isFinite(p50Ns) ? p50Ns / 1e6 : 0,
    p99Ms: Number.isFinite(p99Ns) ? p99Ns / 1e6 : 0,
  };
};

// ── Prometheus text-format renderer ─────────────────────────
// The output is minimal but scraper-compatible: each metric gets a
// `# HELP` line, a `# TYPE` line, then one sample. No labels — if we
// ever need per-label breakdowns (e.g., per-job-type active counts) we'll
// reconsider the "no dep" stance and adopt `prom-client`.

export interface MetricsSnapshot {
  activeJobs: number;
  pendingJobs: number;
  socketConnections: number;
  mongoConnected: 0 | 1;
}

export const renderMetrics = (live: MetricsSnapshot): string => {
  const { activeJobs, pendingJobs, socketConnections, mongoConnected } = live;
  const { p50Ms, p99Ms } = readEventLoopLag();
  const mem = process.memoryUsage();
  const uptime = process.uptime();

  const activeStreams = Math.max(0, sseStreamsStarted - sseStreamsEnded);

  const lines: string[] = [];

  const metric = (
    name: string,
    help: string,
    type: 'counter' | 'gauge',
    value: number,
  ) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name} ${value}`);
  };

  metric('rate_limit_hits_total', 'Rate limiter 429 responses since process start', 'counter', rateLimitHits);
  metric('sse_streams_started_total', 'Lesson SSE streams opened since process start', 'counter', sseStreamsStarted);
  metric('sse_streams_ended_total', 'Lesson SSE streams closed (any reason) since process start', 'counter', sseStreamsEnded);

  metric('sse_streams_active', 'Lesson SSE streams currently in flight', 'gauge', activeStreams);
  metric('job_runner_active', 'Jobs currently executing in jobRunner pLimit', 'gauge', activeJobs);
  metric('job_runner_pending', 'Jobs queued behind pLimit (waiting to start)', 'gauge', pendingJobs);
  metric('socket_connections', 'Currently connected Socket.io clients', 'gauge', socketConnections);
  metric('mongo_connected', '1 if mongoose.connection.readyState === 1, else 0', 'gauge', mongoConnected);

  metric('event_loop_lag_p50_milliseconds', 'Event loop lag p50 over the last scrape window', 'gauge', p50Ms);
  metric('event_loop_lag_p99_milliseconds', 'Event loop lag p99 over the last scrape window', 'gauge', p99Ms);

  metric('process_resident_memory_bytes', 'process.memoryUsage().rss', 'gauge', mem.rss);
  metric('process_heap_used_bytes', 'process.memoryUsage().heapUsed', 'gauge', mem.heapUsed);
  metric('process_heap_total_bytes', 'process.memoryUsage().heapTotal', 'gauge', mem.heapTotal);
  metric('process_uptime_seconds', 'process.uptime() since boot', 'gauge', uptime);

  return lines.join('\n') + '\n';
};
