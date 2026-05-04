/**
 * Uniform LLM cache-usage logging across the three SDKs we use to talk to
 * Anthropic (raw `@anthropic-ai/sdk`, `@langchain/anthropic`, Vercel AI SDK).
 *
 * Why this exists: every model in `lib/langchain.ts` is configured with
 * `cache_control: { type: 'ephemeral' }`, but we previously only logged cache
 * hits from one call site (courseDesign/nodes/chat.ts). We had no signal
 * whether the rest of the LLM traffic — lesson, interactive, recall, quiz,
 * links — was actually getting cache hits, no way to spot regressions when a
 * prompt edit invalidates the cached prefix, and no aggregate visible at
 * `/metrics`.
 *
 * Three SDKs surface usage on three different objects with three different
 * key conventions. The adapters below normalize all of them to one
 * `CacheUsage` shape; `logCacheUsage` formats one log line and bumps
 * per-label counters in `metrics.ts`.
 *
 * Always logs, even when cache_read=0 and cache_creation=0 — silent misses
 * (e.g. a Haiku 4.5 prompt below the 2048-token minimum, or a Sonnet prompt
 * below the 1024-token minimum) are exactly the bug this instrumentation is
 * built to surface.
 */

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import { bumpLlmCallMetrics } from '@lib/metrics';
import { priceLlmUsage } from '@lib/pricing';
import { recordUsage } from '@services/usageService';
import { llmLog } from '@lib/loggers';

export interface CacheUsage {
  cacheRead: number;
  /** Total cache-creation tokens = cacheCreation5m + cacheCreation1h. Kept for display/metrics. */
  cacheCreation: number;
  /** 5-minute ephemeral cache writes (Anthropic default; priced at 1.25× input). */
  cacheCreation5m: number;
  /** 1-hour cache writes (priced at 2× input). Zero unless the call sets `cache_control.ttl: '1h'`. */
  cacheCreation1h: number;
  uncached: number;
  output: number;
}

const ZERO_USAGE: CacheUsage = {
  cacheRead: 0,
  cacheCreation: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  uncached: 0,
  output: 0,
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// If the SDK didn't expose a 5m/1h breakdown we attribute the whole creation
// total to 5m. Every adapter below prefers the breakdown when the provider
// emits it (raw Anthropic always does; LangChain and Vercel AI expose it via
// `response_metadata.usage.cache_creation` / `providerMetadata.anthropic.usage.cache_creation`
// when present) and falls through to this default when the call didn't
// request 1h caching or the SDK stripped the field.
const splitCacheCreation = ({
  total,
  fiveMinute,
  oneHour,
}: {
  total: number;
  fiveMinute: number;
  oneHour: number;
}): { cacheCreation5m: number; cacheCreation1h: number } => {
  const breakdown = fiveMinute + oneHour;
  if (breakdown > 0) return { cacheCreation5m: fiveMinute, cacheCreation1h: oneHour };
  return { cacheCreation5m: total, cacheCreation1h: 0 };
};

/** Raw `@anthropic-ai/sdk` Message.usage shape. */
export const usageFromAnthropic = (response: unknown): CacheUsage => {
  const usage = (response as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage) return ZERO_USAGE;
  const cacheCreation = num(usage.cache_creation_input_tokens);
  const breakdown = usage.cache_creation as { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown } | undefined;
  const { cacheCreation5m, cacheCreation1h } = splitCacheCreation({
    total: cacheCreation,
    fiveMinute: num(breakdown?.ephemeral_5m_input_tokens),
    oneHour: num(breakdown?.ephemeral_1h_input_tokens),
  });
  return {
    cacheRead: num(usage.cache_read_input_tokens),
    cacheCreation,
    cacheCreation5m,
    cacheCreation1h,
    uncached: num(usage.input_tokens),
    output: num(usage.output_tokens),
  };
};

/**
 * LangChain `AIMessage` produced by `ChatAnthropic`. New-style
 * `usage_metadata` (preferred) carries `input_token_details.cache_read` /
 * `cache_creation`; older shapes put the snake_case fields under
 * `response_metadata.usage`. We try both so wrapped chains
 * (`withStructuredOutput`, etc.) and direct `.invoke()` both work.
 *
 * 5m/1h breakdown: `usage_metadata.input_token_details` doesn't expose it,
 * but the raw Anthropic payload forwarded on `response_metadata.usage` does
 * (via `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`).
 * We prefer the breakdown when present so 1h cache writes land on the 2×
 * price bucket instead of being silently billed at 5m's 1.25×.
 */
export const usageFromLangChainAIMessage = (message: unknown): CacheUsage => {
  const msg = message as
    | {
        usage_metadata?: {
          input_tokens?: number;
          output_tokens?: number;
          input_token_details?: { cache_read?: number; cache_creation?: number };
        };
        response_metadata?: {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_creation?: {
              ephemeral_5m_input_tokens?: unknown;
              ephemeral_1h_input_tokens?: unknown;
            };
          };
        };
      }
    | undefined;
  if (!msg) return ZERO_USAGE;

  const raw = msg.response_metadata?.usage;
  const breakdown = raw?.cache_creation;

  const meta = msg.usage_metadata;
  if (meta) {
    const cacheRead = num(meta.input_token_details?.cache_read);
    const cacheCreation = num(meta.input_token_details?.cache_creation);
    // `usage_metadata.input_tokens` is the TOTAL input (cached + uncached) per
    // the LangChain standard. Subtract cache portions to recover the uncached
    // delta the way Anthropic reports it natively.
    const totalInput = num(meta.input_tokens);
    const uncached = Math.max(0, totalInput - cacheRead - cacheCreation);
    const { cacheCreation5m, cacheCreation1h } = splitCacheCreation({
      total: cacheCreation,
      fiveMinute: num(breakdown?.ephemeral_5m_input_tokens),
      oneHour: num(breakdown?.ephemeral_1h_input_tokens),
    });
    return {
      cacheRead,
      cacheCreation,
      cacheCreation5m,
      cacheCreation1h,
      uncached,
      output: num(meta.output_tokens),
    };
  }

  if (raw) {
    const cacheCreation = num(raw.cache_creation_input_tokens);
    const { cacheCreation5m, cacheCreation1h } = splitCacheCreation({
      total: cacheCreation,
      fiveMinute: num(breakdown?.ephemeral_5m_input_tokens),
      oneHour: num(breakdown?.ephemeral_1h_input_tokens),
    });
    return {
      cacheRead: num(raw.cache_read_input_tokens),
      cacheCreation,
      cacheCreation5m,
      cacheCreation1h,
      uncached: num(raw.input_tokens),
      output: num(raw.output_tokens),
    };
  }

  return ZERO_USAGE;
};

/**
 * Vercel AI SDK `streamObject` / `generateObject` result (v6+).
 *
 * In `ai` v6 the `LanguageModelUsage` shape changed: cache read/write counts
 * moved from `providerMetadata.anthropic.{cacheRead,cacheCreation}InputTokens`
 * (v4/v5) to the standardized `usage.inputTokenDetails.{cacheReadTokens,
 * cacheWriteTokens,noCacheTokens}` path. Reading the old paths silently
 * returned 0 for reads, which masked working caches as "uncached" in the
 * log — the exact symptom behind the "lesson:content writes on call 1 then
 * goes dark" mystery. The provider still emits `cache_creation_input_tokens`
 * at `providerMetadata.anthropic.usage.*` (snake_case Anthropic raw usage)
 * and `providerMetadata.anthropic.cacheCreationInputTokens` (explicit,
 * camelCase) — but NOT a matching `cacheReadInputTokens` field, only the
 * standardized path carries read counts. So we prefer the standardized path
 * and fall back to the snake-case raw usage from the provider.
 */
export const usageFromVercelAi = (result: unknown): CacheUsage => {
  const r = result as
    | {
        providerMetadata?: {
          anthropic?: {
            usage?: {
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
              input_tokens?: number;
              cache_creation?: {
                ephemeral_5m_input_tokens?: unknown;
                ephemeral_1h_input_tokens?: unknown;
              };
            };
            cacheCreationInputTokens?: number;
          };
        };
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          inputTokenDetails?: {
            noCacheTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
        };
      }
    | undefined;
  if (!r) return ZERO_USAGE;

  const details = r.usage?.inputTokenDetails;
  const rawAnth = r.providerMetadata?.anthropic?.usage;

  const cacheRead = num(details?.cacheReadTokens) || num(rawAnth?.cache_read_input_tokens);
  const cacheCreation =
    num(details?.cacheWriteTokens) ||
    num(r.providerMetadata?.anthropic?.cacheCreationInputTokens) ||
    num(rawAnth?.cache_creation_input_tokens);

  // `inputTokenDetails.noCacheTokens` is the authoritative uncached count in
  // v6. Fall back to the Anthropic snake-case `input_tokens` (which is
  // uncached-only by Anthropic convention), then to subtraction from the
  // standardized total.
  const uncached =
    num(details?.noCacheTokens) ||
    num(rawAnth?.input_tokens) ||
    Math.max(0, num(r.usage?.inputTokens) - cacheRead - cacheCreation);

  // `inputTokenDetails` doesn't carry the 5m/1h breakdown, but the raw
  // Anthropic payload on `providerMetadata.anthropic.usage.cache_creation`
  // does. Extract the breakdown when present so 1h writes bill at 2× rather
  // than silently at 5m's 1.25×; fall back to the total-into-5m default
  // when the breakdown is absent (older SDK versions / 5m-only calls).
  const breakdown = rawAnth?.cache_creation;
  const { cacheCreation5m, cacheCreation1h } = splitCacheCreation({
    total: cacheCreation,
    fiveMinute: num(breakdown?.ephemeral_5m_input_tokens),
    oneHour: num(breakdown?.ephemeral_1h_input_tokens),
  });

  return {
    cacheRead,
    cacheCreation,
    cacheCreation5m,
    cacheCreation1h,
    uncached,
    output: num(r.usage?.outputTokens),
  };
};

/**
 * Single entry point: log one cyan line, bump per-label counters, AND append
 * a row to the per-user usage ledger via `recordUsage` so the spend is
 * attributed to whichever user's work triggered this call. Called from
 * per-call-site instrumentation (raw Anthropic, Vercel AI) and from the
 * shared LangChain callback handler below.
 *
 * `model` must be the Claude model id (e.g. `claude-sonnet-4-6`) so the
 * pricing table can compute cost. It's wired at callback-construction time
 * in `lib/langchain.ts` and passed explicitly at the raw-SDK / Vercel-AI
 * call sites that bypass the LangChain callback.
 */
export const logCacheUsage = ({ label, usage, model }: { label: string; usage: CacheUsage; model: string }): void => {
  bumpLlmCallMetrics({ label, usage });
  const totalInput = usage.cacheRead + usage.cacheCreation + usage.uncached;
  const hitPct = totalInput > 0 ? Math.round((usage.cacheRead / totalInput) * 100) : 0;
  llmLog.info(
    `${label} read=${usage.cacheRead} write=${usage.cacheCreation} uncached=${usage.uncached} out=${usage.output} hit=${hitPct}%`,
  );
  const costMicroCents = priceLlmUsage({
    model,
    cacheRead: usage.cacheRead,
    cacheCreation5m: usage.cacheCreation5m,
    cacheCreation1h: usage.cacheCreation1h,
    uncached: usage.uncached,
    output: usage.output,
  });
  recordUsage({
    service: 'anthropic',
    action: label,
    costMicroCents,
    metadata: {
      model,
      cacheRead: usage.cacheRead,
      cacheCreation: usage.cacheCreation,
      cacheCreation5m: usage.cacheCreation5m,
      cacheCreation1h: usage.cacheCreation1h,
      uncached: usage.uncached,
      output: usage.output,
    },
  });
};

/**
 * Shared LangChain callback handler. Attached to every `ChatAnthropic`
 * instance in `lib/langchain.ts` via `callbacks: [llmCacheCallback]`, so
 * every `.invoke()` / `.stream()` and every wrapped chain
 * (`withStructuredOutput`, `withRetry`, etc.) is auto-instrumented — no
 * per-call-site changes needed for the LangChain-driven pipelines.
 *
 * Label resolution: each model passes its own label via
 * `metadata: { llmLabel: 'foo:bar' }` when invoked, OR the handler falls
 * back to `metadata.llmLabelDefault` set at construction. This lets
 * `quiz:generate`, `lesson:interactive`, `lesson:recall`, etc. all share
 * one handler instance but emit distinct labels.
 *
 * `handleLLMEnd` receives the raw `LLMResult`. For ChatAnthropic, the
 * usage lives on `generations[0][0].message` (a ChatGeneration carries a
 * BaseMessage), so we route through the LangChain message adapter.
 */
class LlmCacheCallback extends BaseCallbackHandler {
  readonly name = 'LlmCacheCallback';

  constructor(
    private readonly defaultLabel: string,
    private readonly model: string,
  ) {
    super();
  }

  handleLLMEnd(
    output: LLMResult,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    extraParams?: Record<string, unknown>,
  ): void {
    const label = this.resolveLabel(extraParams);
    const message = (output.generations as unknown as Array<Array<{ message?: unknown }>>)?.[0]?.[0]?.message;
    const usage = usageFromLangChainAIMessage(message);
    logCacheUsage({ label, usage, model: this.model });
  }

  private resolveLabel(extraParams?: Record<string, unknown>): string {
    // Run-time invocation may pass `metadata: { llmLabel: 'foo:bar' }`.
    // LangChain forwards `metadata` through `extraParams.metadata`.
    const metadata = (extraParams?.metadata ?? {}) as Record<string, unknown>;
    const fromCall = typeof metadata.llmLabel === 'string' ? metadata.llmLabel : undefined;
    return fromCall ?? this.defaultLabel;
  }
}

/**
 * Factory: one callback handler per model, defaulting label to the model's
 * role. Per-call overrides via `metadata.llmLabel` let downstream code
 * distinguish call sites that share the same model (e.g. `lesson:links.plan`
 * vs `lesson:links.rerank` both use the utility model).
 *
 * `model` is the Claude model id the callback's owning `ChatAnthropic`
 * instance talks to — used by `logCacheUsage` to price the call against
 * `LLM_PRICING` in `lib/pricing.ts`. Registering the id here co-locates
 * label ↔ model so a model swap requires updating exactly one file.
 */
export const makeLlmCacheCallback = ({
  defaultLabel,
  model,
}: {
  defaultLabel: string;
  model: string;
}): BaseCallbackHandler => new LlmCacheCallback(defaultLabel, model);
