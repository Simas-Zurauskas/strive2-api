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

// ── Insight queue / fresh-pool diagnostics ─────────────────
//
// The GET /api/insight/queue endpoint sometimes returns 0 fresh despite the
// user having completed many lessons. These counters tag each invocation
// with the reason the fresh pool came up empty (or `ok`) so production
// traffic reveals which precondition is most often missing.
//
// The label-less style of this module means "counters with a reason label"
// expand to one counter per reason. `insightQueueFreshReason` maps each
// reason string to its running count; the renderer emits them under a
// single metric name with a `reason=` label so Prometheus scrapers can
// still break down the distribution.

export type InsightQueueFreshReason =
  | 'no_active_insights'
  | 'no_completed_lessons'
  | 'candidates_zero'
  | 'all_gated_by_lesson'
  | 'ok'
  | 'due_gated_fresh_skipped';

const INSIGHT_QUEUE_FRESH_REASONS: InsightQueueFreshReason[] = [
  'no_active_insights',
  'no_completed_lessons',
  'candidates_zero',
  'all_gated_by_lesson',
  'ok',
  'due_gated_fresh_skipped',
];

export const insightQueueFreshReason: Record<InsightQueueFreshReason, number> = {
  no_active_insights: 0,
  no_completed_lessons: 0,
  candidates_zero: 0,
  all_gated_by_lesson: 0,
  ok: 0,
  due_gated_fresh_skipped: 0,
};

/**
 * One increment per `getInsightQueue` invocation — tags the fresh-pool
 * decision-path so `/metrics` exposes "why fresh = 0" as a distribution.
 */
export const bumpInsightQueueFreshReason = (reason: InsightQueueFreshReason) => {
  insightQueueFreshReason[reason] += 1;
};

// Running sums of the four raw counts observed on each fresh-pool decision.
// They are emitted as `…_sum` counters paired with a `…_observations_total`
// counter — computing per-request averages on the dashboard (sum / obs) is
// the standard Prometheus pattern for recording distributions without
// shipping a full histogram. Gauges would only reflect the last scraped
// request and drop everything in between.

export let insightQueueFreshActiveInsightCountSum = 0;
export let insightQueueFreshCompletedLessonCountSum = 0;
export let insightQueueFreshCandidateCountSum = 0;
export let insightQueueFreshOutCountSum = 0;
export let insightQueueFreshObservations = 0;

export const recordInsightQueueFreshCounts = (counts: {
  activeInsightCount: number;
  completedLessonCount: number;
  candidateCount: number;
  freshOutCount: number;
}) => {
  insightQueueFreshActiveInsightCountSum += counts.activeInsightCount;
  insightQueueFreshCompletedLessonCountSum += counts.completedLessonCount;
  insightQueueFreshCandidateCountSum += counts.candidateCount;
  insightQueueFreshOutCountSum += counts.freshOutCount;
  insightQueueFreshObservations += 1;
};

// ── Lesson generation outcome + duration ────────────────────
//
// Tracks every generate_lesson job run through the job-runner path. The
// outcome counter catches silent degradations (e.g. persistence-gate
// rejections climbing without anyone noticing), and the duration sum lets
// us compute the average latency per lesson over any window. Outcomes:
//   • 'success'               — agent ran, persistence gate passed, lesson written
//   • 'persistence_gate_fail' — agent ran but contentSummary / block counts
//                               failed the pre-write contract (P2-A gate in
//                               jobRunner.ts)
//   • 'error'                 — any other throw (LLM failure, schema reject,
//                               network, etc.)
// Timeouts are handled one level up via `Promise.race` in processJob and
// don't land here; they already get their own job-row failure state.

export type LessonGenerationOutcome = 'success' | 'persistence_gate_fail' | 'error';

const LESSON_GENERATION_OUTCOMES: LessonGenerationOutcome[] = ['success', 'persistence_gate_fail', 'error'];

export const lessonGenerationOutcome: Record<LessonGenerationOutcome, number> = {
  success: 0,
  persistence_gate_fail: 0,
  error: 0,
};

export const bumpLessonGenerationOutcome = (outcome: LessonGenerationOutcome) => {
  lessonGenerationOutcome[outcome] += 1;
};

export let lessonGenerationDurationMsSum = 0;
export let lessonGenerationDurationObservations = 0;

export const recordLessonGenerationDuration = (ms: number) => {
  lessonGenerationDurationMsSum += ms;
  lessonGenerationDurationObservations += 1;
};

// ── Links generation (curated-links agent) ─────────────────
//
// The curated-links pipeline is a 6-stage funnel (query-plan → search →
// dedupe → fetch → judge → select). We track:
//   • the outcome counter — which stage the pipeline exited at, so we can see
//     how often we ship links vs. fail to, and why;
//   • the candidate-count sum — running total of final-link counts, paired
//     with observations_total for per-lesson average;
//   • the fetch-failure reason counter — which kind of fetch errors are
//     eating candidates (timeout / http / ssrf / empty body).

export type LinksGenerationOutcome =
  | 'shipped'
  | 'zero_candidates'
  | 'zero_fetched'
  | 'zero_judged_above_threshold'
  | 'error';

const LINKS_GENERATION_OUTCOMES: LinksGenerationOutcome[] = [
  'shipped',
  'zero_candidates',
  'zero_fetched',
  'zero_judged_above_threshold',
  'error',
];

export const linksGenerationOutcome: Record<LinksGenerationOutcome, number> = {
  shipped: 0,
  zero_candidates: 0,
  zero_fetched: 0,
  zero_judged_above_threshold: 0,
  error: 0,
};

export const bumpLinksGenerationOutcome = (outcome: LinksGenerationOutcome) => {
  linksGenerationOutcome[outcome] += 1;
};

export let linksCandidateCountSum = 0;
export let linksCandidateCountObservations = 0;

export const recordLinksCandidateCount = (count: number) => {
  linksCandidateCountSum += count;
  linksCandidateCountObservations += 1;
};

export type LinksFetchFailureReason = 'timeout' | 'http_error' | 'ssrf_reject' | 'empty_body';

const LINKS_FETCH_FAILURE_REASONS: LinksFetchFailureReason[] = [
  'timeout',
  'http_error',
  'ssrf_reject',
  'empty_body',
];

export const linksFetchFailure: Record<LinksFetchFailureReason, number> = {
  timeout: 0,
  http_error: 0,
  ssrf_reject: 0,
  empty_body: 0,
};

export const bumpLinksFetchFailure = (reason: LinksFetchFailureReason) => {
  linksFetchFailure[reason] += 1;
};

// ── AI self-correction artifact scrubbing ─────────────────
//
// `sanitizeArtifacts` strips meta-phrases the LLM sometimes leaks into
// rendered explanation/question/option fields ("Actually: 2 + 2 = 5...",
// "Re-selecting correctIndex to 2"). Each incremented sentence = one
// strip; a "gutted" outcome means the sanitizer removed >60% of the
// non-whitespace content and the caller fell back to a placeholder.
//
// A non-zero `artifact_scrub_gutted_total` signals a batch of fully-
// contaminated explanations — that's the prompt-regression alarm.

export let artifactScrubStrips = 0;
export let artifactScrubGutted = 0;

export const bumpArtifactScrubStrips = (n: number) => {
  artifactScrubStrips += n;
};

export const bumpArtifactScrubGutted = () => {
  artifactScrubGutted += 1;
};

// ── Clarify-generation refinement + thin-answer detection ──
//
// `clarifyOutputSchema` requires ≥1 free-text question via a Zod `.refine()`.
// When the LLM produces zero text questions, the refinement trips, withRetry
// catches the Zod failure, and re-invokes the LLM. We bump this counter on
// every retry fired by the refinement (not by JSON-parse failures). Climbing
// values signal prompt drift — the LLM is ignoring the hard-contract rule
// and leaning on retries as a crutch.
//
// `structureThinFreeTextInputsTotal` increments whenever `formatCourseAnswers`
// in jobRunner.ts tags a free-text answer as thin (≤3 tokens). High values
// are informational, not pathological — they mean learners are giving terse
// replies, which is real user behavior. But extremely high values paired
// with depth-recommender over-scoping (Fix D) suggest the clarify prompt is
// eliciting answers too short to be useful.

export let clarifyRefinementRetries = 0;
export let structureThinFreeTextInputs = 0;

export const bumpClarifyRefinementRetry = () => {
  clarifyRefinementRetries += 1;
};

export const bumpStructureThinFreeTextInput = () => {
  structureThinFreeTextInputs += 1;
};

// ── Structure cap validation + depth override gate ─────────
//
// `generateCourseStructure` counts total lessons post-generation and
// regenerates once if the LLM exceeded the cap (set by `getLessonCountHint`
// based on depth + softness). Two counters:
//   • `structure_cap_exceeded_retries_total` — first-attempt-over cases that
//     triggered the corrective regeneration. Rising values are not bad per
//     se (the retry usually fixes it) but signal the base prompt isn't
//     respecting the cap.
//   • `structure_cap_violations_unresolved_total` — second-attempt-also-over
//     cases. Must stay near zero; non-zero indicates a genuine prompt or
//     schema bug.
//
// `depth_override_gate_fired_total` counts 409 responses from updateCourse
// when a SOFT=YES learner tries to upgrade depth without an explicit
// acknowledgement. `depth_override_acknowledged_total` tracks the follow-up
// success path so dashboards can compare first-attempt-blocked vs. final-
// accepted to gauge how often the gate is hit vs. bounced.

export let structureCapExceededRetries = 0;
export let structureCapViolationsUnresolved = 0;
export let depthOverrideGateFired = 0;
export let depthOverrideAcknowledged = 0;

export const bumpStructureCapExceededRetry = () => {
  structureCapExceededRetries += 1;
};

export const bumpStructureCapViolationUnresolved = () => {
  structureCapViolationsUnresolved += 1;
};

export const bumpDepthOverrideGateFired = () => {
  depthOverrideGateFired += 1;
};

export const bumpDepthOverrideAcknowledged = () => {
  depthOverrideAcknowledged += 1;
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

  // ── Insight queue fresh-pool decision distribution ────────
  // One counter per reason, exposed under a shared name with a `reason`
  // label so dashboards can pivot by decision path without breaking the
  // zero-dep stance.
  lines.push('# HELP insight_queue_fresh_reason_total GET /insight/queue fresh-pool decision-path counts');
  lines.push('# TYPE insight_queue_fresh_reason_total counter');
  for (const reason of INSIGHT_QUEUE_FRESH_REASONS) {
    lines.push(`insight_queue_fresh_reason_total{reason="${reason}"} ${insightQueueFreshReason[reason]}`);
  }

  metric(
    'insight_queue_fresh_observations_total',
    'Total GET /insight/queue invocations that produced a fresh-pool observation',
    'counter',
    insightQueueFreshObservations,
  );
  metric(
    'insight_queue_fresh_active_insight_count_sum',
    'Running sum of `activeInsightIds.length` observed per queue request (divide by observations_total for avg)',
    'counter',
    insightQueueFreshActiveInsightCountSum,
  );
  metric(
    'insight_queue_fresh_completed_lesson_count_sum',
    'Running sum of `completedLessonKeys.size` observed per queue request',
    'counter',
    insightQueueFreshCompletedLessonCountSum,
  );
  metric(
    'insight_queue_fresh_candidate_count_sum',
    'Running sum of fresh-candidate rows returned per queue request (pre gating)',
    'counter',
    insightQueueFreshCandidateCountSum,
  );
  metric(
    'insight_queue_fresh_out_count_sum',
    'Running sum of fresh items actually surfaced per queue request',
    'counter',
    insightQueueFreshOutCountSum,
  );

  // ── Lesson generation outcome + duration ─────────────────
  lines.push('# HELP lesson_generation_outcome_total Counts of generate_lesson job terminations by outcome (success / persistence_gate_fail / error)');
  lines.push('# TYPE lesson_generation_outcome_total counter');
  for (const outcome of LESSON_GENERATION_OUTCOMES) {
    lines.push(`lesson_generation_outcome_total{outcome="${outcome}"} ${lessonGenerationOutcome[outcome]}`);
  }

  metric(
    'lesson_generation_duration_ms_sum',
    'Running sum of generate_lesson wall-clock duration across all completions (divide by observations_total for avg)',
    'counter',
    lessonGenerationDurationMsSum,
  );
  metric(
    'lesson_generation_duration_observations_total',
    'Total generate_lesson completions (success or failure) — denominator for the duration sum',
    'counter',
    lessonGenerationDurationObservations,
  );

  // ── Curated-links pipeline ────────────────────────────────
  lines.push('# HELP links_generation_outcome_total Curated-links pipeline terminations by outcome');
  lines.push('# TYPE links_generation_outcome_total counter');
  for (const outcome of LINKS_GENERATION_OUTCOMES) {
    lines.push(`links_generation_outcome_total{outcome="${outcome}"} ${linksGenerationOutcome[outcome]}`);
  }

  metric(
    'links_candidate_count_sum',
    'Running sum of final-link counts shipped per lesson (divide by observations_total for avg)',
    'counter',
    linksCandidateCountSum,
  );
  metric(
    'links_candidate_count_observations_total',
    'Total curated-links pipeline runs — denominator for the candidate-count sum',
    'counter',
    linksCandidateCountObservations,
  );

  lines.push('# HELP links_fetch_failure_total Counts of Jina Reader fetch failures by reason');
  lines.push('# TYPE links_fetch_failure_total counter');
  for (const reason of LINKS_FETCH_FAILURE_REASONS) {
    lines.push(`links_fetch_failure_total{reason="${reason}"} ${linksFetchFailure[reason]}`);
  }

  // ── AI self-correction artifact scrubber ─────────────────
  metric(
    'artifact_scrub_strips_total',
    'Sentences removed by artifactSanitizer across all generation nodes (sum of stripped counts)',
    'counter',
    artifactScrubStrips,
  );
  metric(
    'artifact_scrub_gutted_total',
    'Explanation fields that were >60% meta-phrase and replaced with a fallback placeholder',
    'counter',
    artifactScrubGutted,
  );

  // ── Clarify refinement + thin-answer detection ───────────
  metric(
    'clarify_refinement_retries_total',
    'Times clarifyOutputSchema .refine() tripped on zero-text-question output, forcing withRetry to re-invoke the LLM',
    'counter',
    clarifyRefinementRetries,
  );
  metric(
    'structure_thin_free_text_inputs_total',
    'Times formatCourseAnswers tagged a free-text answer as thin (≤3 tokens) before passing to the structure prompt',
    'counter',
    structureThinFreeTextInputs,
  );

  // ── Structure cap + depth override gate ──────────────────
  metric(
    'structure_cap_exceeded_retries_total',
    'Times generateCourseStructure had to regenerate because the first attempt exceeded the lesson-count cap',
    'counter',
    structureCapExceededRetries,
  );
  metric(
    'structure_cap_violations_unresolved_total',
    'Times the structure regeneration also exceeded the cap — should stay near zero; non-zero signals prompt drift',
    'counter',
    structureCapViolationsUnresolved,
  );
  metric(
    'depth_override_gate_fired_total',
    'Times updateCourse returned 409 DEPTH_OVERRIDE_REQUIRES_ACK (soft learner attempted to upgrade depth without acknowledgement)',
    'counter',
    depthOverrideGateFired,
  );
  metric(
    'depth_override_acknowledged_total',
    'Times a depth override was explicitly acknowledged and accepted after the 409 gate fired',
    'counter',
    depthOverrideAcknowledged,
  );

  return lines.join('\n') + '\n';
};
