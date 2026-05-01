/**
 * Domain-tagged loggers. Each logger stamps lines with a colored `[tag]`
 * prefix and can be flipped on/off at runtime by mutating its `enabled`
 * property — `monetization.enabled = false` mutes the domain everywhere
 * without touching call sites.
 *
 * This file is the single place to register a new domain. Add a line at the
 * bottom (`export const jobs = createLogger({ tag: 'jobs', color: 'cyan' })`)
 * and import it from anywhere. That gives us one scannable catalog of
 * "what's talking to stdout" — the same ergonomic `bumpX()` counter pattern
 * used in `lib/metrics.ts`, applied to logs.
 *
 * Deliberately NOT plumbed to Sentry or structured JSON — this is stdout
 * tailing. Sentry capture already happens at the throw site (see `bgError`,
 * `errorMiddleware`). For `recordUsage`-style high-cardinality events we
 * have `UsageEventModel` + the per-label counters in `metrics.ts`; don't
 * firehose every token through here.
 */

import 'colors';

type ColorName = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'gray' | 'white';

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
  enabled = true,
}: {
  tag: string;
  color: ColorName;
  enabled?: boolean;
}): Logger => {
  // Closed-over state so the returned object's methods see mutations to
  // `enabled` immediately (the getter below delegates here).
  const state = { enabled };

  // `colors` augments String.prototype with color-named getters, so dynamic
  // selection by config name needs a cast from the keyed-access type.
  const paint = (s: string): string => (s as unknown as Record<ColorName, string>)[color];
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
//
// One exported logger per domain. Each line below is the domain's canonical
// import target (`import { monetization } from '@lib/loggers'`).

/**
 * Money in/out of users' balances: Stripe webhooks (checkout, subscription
 * lifecycle, invoice, refund, dispute), credit grants + debits, free-period
 * resets, and the two balance gates (requireCredits, maxConcurrentJobs).
 * Does NOT cover per-token usage accounting — that's `UsageEventModel` +
 * the `llm_*_total` metrics in `lib/metrics.ts`.
 */
export const monetization = createLogger({ tag: 'monetization', color: 'magenta', enabled: true });

/**
 * The 3 chat surfaces that share an Anthropic + LangGraph spine: the
 * lesson mentor, the course mentor, and the course-design wizard. Use
 * one tag (`chat`) and discriminate inside the message body so a single
 * `grep '[chat]'` shows the whole turn lifecycle across all three.
 *
 * Message convention:
 *   `<scope>:<phase> <event> [k=v …]`
 *   - scope ∈ { lesson | course | design }
 *   - phase ∈ { turn | compress | save | route | tool | stream | fallback }
 *
 * Examples:
 *   [chat] lesson:turn start course=… module=0 lesson=2 messages=12 hasSummary=false
 *   [chat] lesson:compress passthrough — no summary needed yet (3/10)
 *   [chat] lesson:tool start name=search_lesson_content args={"query":"…"}
 *   [chat] lesson:tool done name=search_lesson_content ms=420 ok=true
 *   [chat] lesson:turn done ms=3210 text=842c tools=1
 *
 * Token-spend / cache-hit telemetry stays in `cacheLogger.ts`
 * (`[llm:…]`) — that's a different domain (cost accounting) with its
 * own audience and shouldn't be filtered together with chat flow logs.
 */
export const chat = createLogger({ tag: 'chat', color: 'cyan', enabled: true });
