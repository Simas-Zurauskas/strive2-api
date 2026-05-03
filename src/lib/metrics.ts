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

export const bumpRateLimitHit = () => {
  rateLimitHits += 1;
};

/**
 * One bump per `debitActualSpend` call that exhausted its 3-retry compare-
 * and-swap loop without a successful debit. The user got free work; the
 * UsageEvent row still captures the real spend for analytics, but no credits
 * were deducted. Rare in practice (concurrent debits on the same user are
 * uncommon), but the rate climbing signals a load-pattern regression — a
 * reconciliation sweep is then warranted.
 */
export let creditDebitExhausted = 0;

export const bumpCreditDebitExhausted = () => {
  creditDebitExhausted += 1;
};

// ── withRetry storms (per-label) ──────────────────────────
//
// `withRetry` (lib/retry.ts) accepts an optional `label` so each call
// site can be attributed in metrics. When set, every retry attempt
// bumps `withRetryTotal[label]`. Used to identify which structured-
// output / network calls are flaky enough to be regularly retrying
// (e.g. a Zod schema that the LLM keeps drifting from). Unlabelled
// retries are intentionally NOT counted — the metric is opt-in
// observability, not a global retry counter.

export const withRetryTotal: Record<string, number> = {};

export const bumpWithRetry = (label: string) => {
  withRetryTotal[label] = (withRetryTotal[label] ?? 0) + 1;
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

// ── Quiz distractor-lint retry loop ────────────────────────
//
// Both quiz-generation nodes (inline interactive in lesson-gen and
// module-quiz) run every MCQ through `lintDistractors` and re-invoke the
// LLM with violation feedback if any rule trips. Retry-on-lint-fail is
// capped; the final attempt ships even if still violating (shipping a
// mediocre quiz beats shipping none).
//
// - `_retry_total` — attempts beyond the first, regardless of final outcome.
//   A climbing value means the prompt is drifting or the rules need a
//   worked example in the system prompt.
// - `_hard_fail_total` — retries exhausted, violations persisted, and the
//   lesson shipped with a flagged quiz. This is the signal to strengthen
//   the retry budget, the prompt, or the rules themselves.
// - `_repaired_total` — residual violations after the final retry were
//   cleared mechanically by `repairDistractors` (hedge absolute qualifiers
//   / trim correct-answer tail) so the block shipped lint-clean. A high
//   repaired count paired with a low hard-fail count means the mechanical
//   pass is carrying load the LLM feedback loop couldn't; a high
//   hard-fail count means the repair escape hatches don't cover the
//   observed failure modes and the prompt or rules need work.

export let quizDistractorLintRetry = 0;
export let quizDistractorLintHardFail = 0;
export let quizDistractorLintRepaired = 0;
export let quizDistractorLintLengthOnlyShipped = 0;

export const bumpQuizDistractorLintRetry = () => {
  quizDistractorLintRetry += 1;
};

export const bumpQuizDistractorLintHardFail = () => {
  quizDistractorLintHardFail += 1;
};

export const bumpQuizDistractorLintRepaired = () => {
  quizDistractorLintRepaired += 1;
};

// One bump per block/question that shipped with only `length-uniformity`
// violations (no `correct-is-longest`, no `distractor-absolute-qualifier`).
// The feedback loop used to retry + hard-fail these, burning LLM calls on
// a low-signal rule whose skim-gaming defense is already covered by
// `correct-not-longest`. Counting them separately keeps visibility without
// polluting the hard-fail dashboard.
export const bumpQuizDistractorLintLengthOnlyShipped = () => {
  quizDistractorLintLengthOnlyShipped += 1;
};

// ── Interactive + quiz model-tier escalation ──
// Inline-quiz + exercise generation (`interactiveGeneration`) and module-
// quiz synthesis (`quizGeneration`) both attempt Haiku first, then escalate
// to Sonnet on schema / count-floor failure OR on distractor-lint residuals
// that survive the deterministic repair pass. Ratio
// (escalations / attempts) is the signal: if >~10%, Haiku isn't carrying
// the task and we should revert the downshift.
export let interactiveHaikuAttempts = 0;
export let interactiveSonnetEscalations = 0;
export let quizHaikuAttempts = 0;
export let quizSonnetEscalations = 0;

export const bumpInteractiveHaikuAttempt = () => {
  interactiveHaikuAttempts += 1;
};
export const bumpInteractiveSonnetEscalation = () => {
  interactiveSonnetEscalations += 1;
};
export const bumpQuizHaikuAttempt = () => {
  quizHaikuAttempts += 1;
};
export const bumpQuizSonnetEscalation = () => {
  quizSonnetEscalations += 1;
};

// ── Tavily cross-lesson search dedup ──
// Course-scoped cache in `links/searchCache.ts` short-circuits Tavily calls
// when a sibling lesson already searched the same normalized query within
// the TTL window. Each hit saves one `tavily_search_advanced` unit at
// $0.016. Divide by total Tavily call count (recorded via recordUsage) to
// get the hit ratio.
export let tavilySearchDedupHits = 0;

export const bumpTavilySearchDedupHit = () => {
  tavilySearchDedupHits += 1;
};

// ── Content-validation repair fallback (Haiku → Sonnet) ──
// `contentValidation` fires structural-repair when a lesson comes back
// missing intro/summary/sections. Haiku runs first (5× cheaper); a schema
// mismatch or empty response triggers a Sonnet retry. Ratio of attempts vs
// fallbacks is the signal: if fallbacks climb past ~5% Haiku isn't carrying
// the task and we should revert the downshift.
export let contentValidationRepairHaikuAttempts = 0;
export let contentValidationRepairHaikuFallbacks = 0;

export const bumpContentValidationRepairHaikuAttempt = () => {
  contentValidationRepairHaikuAttempts += 1;
};

export const bumpContentValidationRepairHaikuFallback = () => {
  contentValidationRepairHaikuFallbacks += 1;
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

// ── Structure cap observation + depth override gate ────────
//
// `generateCourseStructure` exposes the LLM's lesson-count-cap adherence
// as a pure observation counter (no action taken on miss — see the
// function's comment for the "suggestion, not hard rule" rationale):
//   • `structure_cap_exceeded_total` — times the LLM produced more
//     lessons than the (depth, soft)-derived `capMax`. Dashboards can
//     alert on rate rather than absolute count; a non-trivial rate is
//     informational feedback that the prompt could be tightened, not a
//     failure signal.
//
// `depth_override_gate_fired_total` counts 409 responses from updateCourse
// when a SOFT=YES learner tries to upgrade depth without an explicit
// acknowledgement. `depth_override_acknowledged_total` tracks the follow-up
// success path so dashboards can compare first-attempt-blocked vs. final-
// accepted to gauge how often the gate is hit vs. bounced.
//
// `depth_undercommit_gate_fired_total` is the symmetric counter for the
// undercommit half of the depth-override gate — fires when the learner
// picks BELOW the recommended tier and the LLM judges the coverage gap is
// meaningful (undercommitRisk = 'moderate' or 'high'). Tracked separately
// from the overcommit counter because the two failure modes are
// qualitatively different (cost-of-completion vs. coverage-gap) and want
// to be charted independently.

export let structureCapExceeded = 0;
export let depthOverrideGateFired = 0;
export let depthOverrideAcknowledged = 0;
export let depthUndercommitGateFired = 0;
export let depthUndercommitAcknowledged = 0;

export const bumpStructureCapExceeded = () => {
  structureCapExceeded += 1;
};

export const bumpDepthOverrideGateFired = () => {
  depthOverrideGateFired += 1;
};

export const bumpDepthOverrideAcknowledged = () => {
  depthOverrideAcknowledged += 1;
};

export const bumpDepthUndercommitGateFired = () => {
  depthUndercommitGateFired += 1;
};

export const bumpDepthUndercommitAcknowledged = () => {
  depthUndercommitAcknowledged += 1;
};

// ── LLM cache + token usage (per-label) ─────────────────────
// Every Claude model in `lib/langchain.ts` is configured with ephemeral
// prompt caching, but until now we had no aggregate visibility into hit
// rates. These per-label maps mirror the `insightQueueFreshReason` pattern:
// one logical metric, broken down by a `label` (e.g. `lesson:content`,
// `quiz:generate`) so dashboards can pivot per-call-site without breaking
// the zero-dep stance.
//
// Bumped from `lib/ai/cacheLogger.ts` on every LLM call (LangChain via
// callback handler, Vercel AI + raw Anthropic via direct call).
//
// Cache hit ratio in Grafana:
//   rate(llm_cache_read_tokens_total[5m])
//     / (rate(llm_cache_read_tokens_total[5m])
//         + rate(llm_cache_write_tokens_total[5m])
//         + rate(llm_uncached_input_tokens_total[5m]))

export const llmCallTotal: Record<string, number> = {};
export const llmCacheReadTokensTotal: Record<string, number> = {};
export const llmCacheWriteTokensTotal: Record<string, number> = {};
export const llmUncachedInputTokensTotal: Record<string, number> = {};
export const llmOutputTokensTotal: Record<string, number> = {};

const bumpKey = (store: Record<string, number>, key: string, delta: number): void => {
  store[key] = (store[key] ?? 0) + delta;
};

export const bumpLlmCallMetrics = ({
  label,
  usage,
}: {
  label: string;
  usage: { cacheRead: number; cacheCreation: number; uncached: number; output: number };
}): void => {
  bumpKey(llmCallTotal, label, 1);
  bumpKey(llmCacheReadTokensTotal, label, usage.cacheRead);
  bumpKey(llmCacheWriteTokensTotal, label, usage.cacheCreation);
  bumpKey(llmUncachedInputTokensTotal, label, usage.uncached);
  bumpKey(llmOutputTokensTotal, label, usage.output);
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
  metric(
    'credit_debit_exhausted_total',
    'debitActualSpend calls that lost all 3 retries of the atomic compare-and-swap — the job completed but no credits were deducted',
    'counter',
    creditDebitExhausted,
  );

  // ── withRetry attempts (per-label) ─────────────────────────
  // One counter per labelled call site. Bumped once per retry attempt
  // (not per call), so a high value for a label means that call site is
  // chronically retrying — typical cause is LLM structured-output drift
  // against a strict Zod schema. Cardinality is bounded by the number
  // of unique labels passed to `withRetry`.
  if (Object.keys(withRetryTotal).length > 0) {
    lines.push('# HELP with_retry_total Retry attempts inside lib/retry.ts withRetry, keyed by caller-supplied label');
    lines.push('# TYPE with_retry_total counter');
    for (const [label, count] of Object.entries(withRetryTotal)) {
      // Escape any double-quotes / backslashes the caller-supplied label
      // might contain. Labels are static strings in practice, but
      // defensive escaping keeps the Prometheus exposition format valid.
      const escaped = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      lines.push(`with_retry_total{label="${escaped}"} ${count}`);
    }
  }

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

  // ── Quiz distractor-lint retry loop ──────────────────────
  metric(
    'quiz_distractor_lint_retry_total',
    'Retry invocations fired by the interactive / module-quiz nodes after a distractor-lint violation on a prior attempt (counts retries, not attempts)',
    'counter',
    quizDistractorLintRetry,
  );
  metric(
    'quiz_distractor_lint_hard_fail_total',
    'Lessons / modules that exhausted the retry budget with violations still present and shipped anyway',
    'counter',
    quizDistractorLintHardFail,
  );
  metric(
    'quiz_distractor_lint_repaired_total',
    'Blocks where mechanical repair (hedge absolute qualifiers, trim correct-answer tail) cleared residual violations after the retry budget exhausted — converted a would-be hard-fail into a clean ship',
    'counter',
    quizDistractorLintRepaired,
  );
  metric(
    'quiz_distractor_lint_length_only_shipped_total',
    'Blocks that shipped with only length-uniformity violations (no correct-is-longest, no absolute-qualifier). Retry is skipped for these — the skim-gaming defense is already covered by correct-not-longest',
    'counter',
    quizDistractorLintLengthOnlyShipped,
  );

  // ── Tavily cross-lesson search dedup ────────────────────
  metric(
    'tavily_search_dedup_hits_total',
    'Tavily queries served from the course-scoped cache instead of hitting the API. Each hit saves $0.016 of search spend',
    'counter',
    tavilySearchDedupHits,
  );

  // ── Interactive + quiz model-tier escalation ──────────
  metric(
    'interactive_haiku_attempts_total',
    'Inline-quiz + exercise generations that tried Haiku first (cost-down from Sonnet)',
    'counter',
    interactiveHaikuAttempts,
  );
  metric(
    'interactive_sonnet_escalations_total',
    'Inline-quiz + exercise generations where Haiku failed (schema / count-floor / distractor-lint residual) and the code escalated to Sonnet — ratio >~10% means revert the downshift',
    'counter',
    interactiveSonnetEscalations,
  );
  metric(
    'quiz_haiku_attempts_total',
    'Module-quiz synthesis calls that tried Haiku first (cost-down from Sonnet)',
    'counter',
    quizHaikuAttempts,
  );
  metric(
    'quiz_sonnet_escalations_total',
    'Module-quiz synthesis calls that escalated to Sonnet after Haiku failure (schema / distractor-lint residual) — ratio >~10% means revert the downshift',
    'counter',
    quizSonnetEscalations,
  );

  // ── Content-validation repair model tier ─────────────────
  metric(
    'content_validation_repair_haiku_attempts_total',
    'Content-validation repair calls that tried Haiku first (cost-down from Sonnet)',
    'counter',
    contentValidationRepairHaikuAttempts,
  );
  metric(
    'content_validation_repair_haiku_fallbacks_total',
    'Content-validation repair calls where Haiku failed (schema / empty response) and the code fell back to Sonnet — ratio >~5% means revert the downshift',
    'counter',
    contentValidationRepairHaikuFallbacks,
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
    'structure_cap_exceeded_total',
    'Times the structure generator produced more lessons than the (depth, soft)-derived capMax. Observation-only: cap is a prompt suggestion, not a hard rule',
    'counter',
    structureCapExceeded,
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
  metric(
    'depth_undercommit_gate_fired_total',
    'Times updateCourse returned 409 DEPTH_UNDERCOMMIT_REQUIRES_ACK (learner picked a depth below recommended and the LLM flagged a meaningful coverage gap)',
    'counter',
    depthUndercommitGateFired,
  );
  metric(
    'depth_undercommit_acknowledged_total',
    'Times the undercommit warning was explicitly acknowledged and accepted after the 409 gate fired',
    'counter',
    depthUndercommitAcknowledged,
  );

  // ── LLM cache + token usage (per-label) ──────────────────
  // One row per (metric, label) pair. Labels are emitted in insertion
  // order, which is also approximately call-site discovery order — fine
  // for Prometheus, which doesn't care about ordering.
  const labels = Array.from(
    new Set([
      ...Object.keys(llmCallTotal),
      ...Object.keys(llmCacheReadTokensTotal),
      ...Object.keys(llmCacheWriteTokensTotal),
      ...Object.keys(llmUncachedInputTokensTotal),
      ...Object.keys(llmOutputTokensTotal),
    ]),
  );

  const llmMetricGroup = (
    name: string,
    help: string,
    store: Record<string, number>,
  ) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const label of labels) {
      lines.push(`${name}{label="${label}"} ${store[label] ?? 0}`);
    }
  };

  if (labels.length > 0) {
    llmMetricGroup(
      'llm_call_total',
      'LLM .invoke / .stream / streamObject completions, broken down by call-site label (e.g. lesson:content, quiz:generate)',
      llmCallTotal,
    );
    llmMetricGroup(
      'llm_cache_read_tokens_total',
      'Anthropic prompt-cache read tokens (cache hits) summed per label',
      llmCacheReadTokensTotal,
    );
    llmMetricGroup(
      'llm_cache_write_tokens_total',
      'Anthropic prompt-cache creation tokens (cache misses that wrote a new entry) summed per label',
      llmCacheWriteTokensTotal,
    );
    llmMetricGroup(
      'llm_uncached_input_tokens_total',
      'Input tokens that bypassed the cache (post-breakpoint or below model min-cache size) summed per label',
      llmUncachedInputTokensTotal,
    );
    llmMetricGroup(
      'llm_output_tokens_total',
      'LLM output tokens summed per label',
      llmOutputTokensTotal,
    );
  }

  return lines.join('\n') + '\n';
};
