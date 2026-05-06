/**
 * Domain-tagged loggers. Each logger stamps lines with a colored `[tag]`
 * prefix and can be flipped on/off at runtime by mutating its `enabled`
 * property — `monetizationLog.enabled = false` mutes the domain everywhere
 * without touching call sites.
 *
 * One exported logger per domain is the only sanctioned way to write to
 * stdout from this server. Bare `console.log` is reserved for tests and
 * scripts; production code paths route through here so a `grep '[tag]'`
 * tail isolates one concern at a time.
 *
 * Deliberately NOT plumbed to Sentry or structured JSON — this is stdout
 * tailing. Sentry capture happens at the throw site (see `bgError`,
 * `errorMiddleware`). For high-cardinality cost telemetry use `recordUsage`
 * + `UsageEventModel` and the per-label counters in `metrics.ts`; don't
 * firehose every token through here.
 *
 * ── Catalog ────────────────────────────────────────────────
 *
 *   lifecycleLog     server boot/shutdown, mongo connect, socket connect/
 *                    disconnect, env validation, rate-limit hits
 *   jobLog           async job orchestration: claim/complete/fail/cancel,
 *                    course active-job mutex, orphan-job reaper
 *   genLog           AI content-generation pipelines (course structure,
 *                    lessons, quizzes, interactive, recall, hero, links)
 *   chatLog          mentor/design chat agents (lesson, course, design)
 *   ragLog           Pinecone vector index ops + OpenAI embedding calls
 *   ttsLog           Google TTS narration synth + S3 dedup cache
 *   monetizationLog  Stripe webhooks, credit grants/debits, balance gates
 *   integrationLog   external HTTP vendors (Jina, Judge0, Mailgun, BFL,
 *                    attachment parsers, S3 cleanup) — transport-level
 *   llmLog           per-call LLM token usage + cache-hit telemetry
 *                    (audience: cost; bumps metrics + recordUsage)
 *
 * Picking the right one
 * ---------------------
 * • If a human operator would care: lifecycleLog / jobLog / monetizationLog
 * • If a content engineer is debugging output quality: genLog / chatLog
 * • If a perf engineer is debugging cache or spend: llmLog
 * • If a transient third-party hiccup: integrationLog
 * • If a vector-store anomaly: ragLog
 * • If audio is missing: ttsLog
 *
 * Message format
 * --------------
 * Every line is the unstructured part the call site writes; the prefix
 * `[tag]` is appended automatically. Use `<scope>:<phase> <event> k=v …`
 * for domains that span multiple subsystems (genLog, chatLog) so a single
 * tag's stream stays grep-friendly.
 */

import 'colors';

type ColorName = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'gray' | 'white';

// Modifiers carry semantic weight in the catalog below — bold = operator
// should notice, italic = background hum, dim = high-volume / low-priority
// per-line. They also disambiguate two loggers that share a color (chat
// vs. llm both cyan; tts vs. monetization both magenta) without expanding
// the foreground palette into colors that read as alarms (red, bgRed).
type Modifier = 'bold' | 'italic' | 'dim' | 'underline';

export interface Logger {
  readonly tag: string;
  /** Mutable — flip at any time to silence the domain. */
  enabled: boolean;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const createLogger = ({
  tag,
  color,
  modifiers = [],
  enabled = true,
}: {
  tag: string;
  color: ColorName;
  modifiers?: Modifier[];
  enabled?: boolean;
}): Logger => {
  const state = { enabled };

  // `colors` augments String.prototype with color/modifier getters, so
  // dynamic selection by config name needs a cast from the keyed-access
  // type. Modifiers compose left-to-right via the same chained-getter API
  // (`'foo'.cyan.dim`); applying them after the color keeps the resulting
  // ANSI sequence in the conventional `<color><attr>…` order.
  const paint = (s: string): string => {
    type Stylable = Record<ColorName | Modifier, string>;
    let out = (s as unknown as Stylable)[color];
    for (const m of modifiers) out = (out as unknown as Stylable)[m];
    return out;
  };
  const prefix = paint(`[${tag}]`);

  return {
    tag,
    get enabled(): boolean {
      return state.enabled;
    },
    set enabled(value: boolean) {
      state.enabled = value;
    },
    info(message: string): void {
      if (state.enabled) console.log(`${prefix} ${message}`);
    },
    warn(message: string): void {
      if (state.enabled) console.warn(`${prefix} ${message}`);
    },
    error(message: string): void {
      if (state.enabled) console.error(`${prefix} ${message}`);
    },
  };
};

// ── Registered loggers ──────────────────────────────────────

/**
 * Server lifecycle + plumbing: process boot, graceful shutdown, MongoDB
 * connect/disconnect, index sync, orphan-job reaper, Socket.io client
 * connect/disconnect, environment validation, rate-limit hits. The "is
 * the system alive and what plumbing is up" log.
 *
 * Pairs with health probes (`/live`, `/ready`) which return state to the
 * load balancer; this logger explains *why* the state changed.
 */
export const lifecycleLog = createLogger({
  tag: 'lifecycle',
  color: 'gray',
  modifiers: ['italic'],
  enabled: true,
});

/**
 * Async job orchestration. The job runner (`services/jobRunner.ts`) and
 * the course active-job mutex (`services/courseService.ts`) both write
 * here: every job lifecycle transition (claim → run → complete | fail |
 * cancel) gets one line, plus orphan reaper and shutdown drain.
 *
 * Format: `<jobType>:<phase> jobId=… userId=… courseId=… …`
 * Examples:
 *   [job] generateLesson:start    jobId=… course=… module=0 lesson=2
 *   [job] generateLesson:done     jobId=… ms=87320 cost=µ¢2310
 *   [job] generateLesson:fail     jobId=… ms=12010 reason=anthropic_timeout
 *   [job] reaper:swept count=3
 *
 * Doesn't log: the AI-generation chatter that fires *inside* a job —
 * that's `genLog`. Token spend per call is `llmLog`.
 */
export const jobLog = createLogger({
  tag: 'job',
  color: 'yellow',
  modifiers: ['bold'],
  enabled: true,
});

/**
 * AI content-generation pipelines. Covers course-structure planning,
 * per-lesson content generation + validation + repair, interactive block
 * authoring, quiz/distractor generation, recall card extraction, hero image
 * synthesis, and the link-curation sub-pipeline (query plan → search →
 * fetch → dedupe → rerank → select).
 *
 * Format: `<scope>:<phase> <event> [k=v …]`
 *   - scope ∈ { course | lesson | quiz | interactive | recall |
 *               hero | links }
 *   - phase ∈ { plan | generate | validate | repair | finalize | … }
 *
 * Examples:
 *   [gen] course:structure plan ms=8420 modules=6
 *   [gen] lesson:content generate attempt=1 blocks=14 ms=42100
 *   [gen] lesson:content validate fail block=7 reason=mermaid_parse
 *   [gen] lesson:content repair attempt=2 ok=true
 *   [gen] lesson:hero cache=miss bytes=482194 ms=11200
 *   [gen] links:rerank candidates=24 selected=5 ms=1820
 *   [gen] quiz:lint distractor-issues=2 fixed=2
 *
 * Doesn't log: Anthropic raw payloads, token usage (that's `llmLog`),
 * mentor turns (that's `chatLog`).
 */
export const genLog = createLogger({ tag: 'gen', color: 'green', enabled: true });

/**
 * The 3 chat surfaces that share an Anthropic + LangGraph spine: the
 * lesson mentor, the course mentor, and the course-design wizard. One
 * tag, scope-prefixed body, so a single `grep '[chat]'` shows the whole
 * turn lifecycle across all three surfaces.
 *
 * Format: `<scope>:<phase> <event> [k=v …]`
 *   - scope ∈ { lesson | course | design }
 *   - phase ∈ { turn | compress | save | route | tool | stream | fallback }
 *
 * Examples:
 *   [chat] lesson:turn  start course=… module=0 lesson=2 messages=12
 *   [chat] lesson:tool  start name=search_lesson_content args={"query":"…"}
 *   [chat] lesson:tool  done  name=search_lesson_content ms=420 ok=true
 *   [chat] lesson:turn  done  ms=3210 text=842c tools=1
 *
 * Doesn't log: per-call token spend or cache hits — those land on
 * `llmLog`.
 */
export const chatLog = createLogger({ tag: 'chat', color: 'cyan', enabled: true });

/**
 * Lesson RAG: Pinecone index upsert/query/delete + OpenAI embedding
 * calls. The "is retrieval working" log.
 *
 * Examples:
 *   [rag] index:upsert  lesson=… chunks=18 vectors=18 ms=820
 *   [rag] index:delete  lesson=… deleted=18
 *   [rag] query:hits    lesson=… q="when do I cast?" results=4 topScore=0.81
 *   [rag] query:miss    lesson=… q="…" reason=index_empty
 *   [rag] embed:done    chunks=18 tokens=4920 ms=1340
 */
export const ragLog = createLogger({ tag: 'rag', color: 'blue', enabled: true });

/**
 * Lesson narration TTS. Tracks Google WaveNet synth attempts, S3 dedup
 * cache hits/misses (content-hashed), and per-job audio sizes. Audience
 * is product (Is narration generating? How often do we dedup?) and
 * billing (TTS spend ladder).
 *
 * Examples:
 *   [tts] synth:start lesson=… voice=en-US-Neural2-D chars=4820
 *   [tts] synth:done  lesson=… ms=8420 bytes=412004 cached=false
 *   [tts] dedup:hit   hash=ab… lesson=…
 *   [tts] synth:fail  lesson=… reason=quota_exceeded
 */
export const ttsLog = createLogger({
  tag: 'tts',
  color: 'magenta',
  modifiers: ['italic'],
  enabled: true,
});

/**
 * Money in/out of users' balances: Stripe webhooks (checkout, subscription
 * lifecycle, invoice, refund, dispute), credit grants + debits, free-period
 * resets, and the balance gates (`requireCredits`). Audit-grade — every
 * line is meant to survive forensic review.
 *
 * Per-token usage accounting is on `llmLog` + `UsageEventModel` —
 * this domain is dollars in/out only.
 */
export const monetizationLog = createLogger({
  tag: 'monetization',
  color: 'magenta',
  modifiers: ['bold'],
  enabled: true,
});

/**
 * External HTTP integrations: Jina reader, Tavily search transport,
 * Judge0 code execution, Mailgun email send, BFL image API, attachment
 * PDF/text parsers, S3 object cleanup. The "third-party hiccup" log.
 *
 * Format: `<vendor>:<op> <event> [k=v …]`
 * Examples:
 *   [integration] jina:fetch       ok url=… ms=1820 bytes=12400
 *   [integration] jina:fetch       fail url=… status=503 ms=8200
 *   [integration] judge0:exec      ok lang=python ms=420 stdout=120c
 *   [integration] mailgun:send     ok to=u@ex template=verify
 *   [integration] mailgun:send     fail to=u@ex status=502
 *   [integration] bfl:gen          ok ms=11200 bytes=482194
 *   [integration] s3:deletePrefix  prefix=lessons/…/ deleted=18
 *
 * The orchestration narrative ("this Tavily call was for lesson X step
 * 'rerank'") stays on `genLog`; this domain is transport-only.
 */
export const integrationLog = createLogger({ tag: 'integration', color: 'white', enabled: true });

/**
 * Per-call LLM token usage + cache-hit telemetry. Single source of truth
 * for "did the prompt cache work?" and "how much did this call cost?".
 *
 * Driven by `lib/ai/cacheLogger.ts` — the entry point also bumps the
 * per-label `llm_*_total` counters in `metrics.ts` AND appends a row to
 * `UsageEventModel` via `recordUsage`, so this logger is the *display*
 * surface, not the durable record. Always logs (even on full-miss) —
 * silent misses are exactly the bug this instrumentation is built to
 * surface.
 *
 * Examples:
 *   [llm] lesson:content     read=8120 write=0 uncached=440 out=2310 hit=95%
 *   [llm] quiz:generate      read=0    write=4820 uncached=120 out=1420 hit=0%
 *   [llm] mentor:lesson.tool read=2310 write=0 uncached=0 out=120 hit=100%
 */
export const llmLog = createLogger({
  tag: 'llm',
  color: 'cyan',
  modifiers: ['dim'],
  enabled: true,
});
