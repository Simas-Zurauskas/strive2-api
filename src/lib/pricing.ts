import 'colors';

/**
 * Single source of truth for how much every paid action costs us.
 *
 * Everything is denominated in **microcents** (integer). 1 cent = 10 000
 * microcents, so the smallest Anthropic token charge we'd want to represent
 * (~0.0001 ¢) is still an integer ≥ 1. Storing money as floating-point
 * dollars or even cents would drift by hundreds of dollars across millions
 * of sub-cent LLM rows summed into an allowance balance — the kind of bug
 * that only surfaces after we've promised a user a quota.
 *
 * Numbers were reconciled against the public vendor pricing pages on
 * 2026-04-21. Confirm against the provider dashboards before any of this
 * gates real billing; wrong numbers here produce wrong allowance accounting
 * silently. If a model lookup fails we warn once and fall through with 0
 * cost — a visible zero beats a plausible-but-wrong invoice.
 *
 * When swapping a model (e.g. Haiku 4.5 → 4.7), add the new id to LLM_PRICING
 * and point `LABEL_TO_MODEL` in `lib/langchain.ts` at it; no other file needs
 * to change.
 */

// ── Model + service pricing tables ─────────────────────────

export interface LlmPrice {
  /** $ per 1M uncached input tokens, expressed in microcents (¢ × 10^4). */
  inputMicroCentsPerMTok: number;
  /** $ per 1M output tokens. */
  outputMicroCentsPerMTok: number;
  /** $ per 1M tokens written to the 5-minute ephemeral prompt cache (Anthropic: 1.25× input). */
  cacheWrite5mMicroCentsPerMTok: number;
  /** $ per 1M tokens written to the 1-hour prompt cache (Anthropic: 2× input). Zero for services that don't offer tiered caching. */
  cacheWrite1hMicroCentsPerMTok: number;
  /** $ per 1M tokens read from the prompt cache (Anthropic: 0.1× input). */
  cacheReadMicroCentsPerMTok: number;
}

/**
 * Per-model / per-service token pricing. Keys for Claude match `MODEL_IDS` in
 * `lib/langchain.ts`. `jina_reader_paid` is stored here (not in
 * `SERVICE_PRICING`) because Jina Reader bills per token returned, not per
 * fetch — routing it through `priceLlmUsage` keeps all token-priced services
 * on one code path.
 *
 * Anthropic cache-write has two durations: ephemeral/5m at 1.25× input and
 * 1h at 2× input. We price them independently so a future `ttl: '1h'`
 * breakpoint lands on the correct multiplier without a pricing-table edit.
 *
 * If a call arrives for a model not in this table, `priceLlmUsage` logs once
 * and returns 0 so the missing-model signal is loud rather than silently
 * under-billing.
 */
export const LLM_PRICING: Record<string, LlmPrice> = {
  'claude-sonnet-4-6': {
    inputMicroCentsPerMTok: 3_000_000,         // $3.00/M
    outputMicroCentsPerMTok: 15_000_000,       // $15.00/M
    cacheWrite5mMicroCentsPerMTok: 3_750_000,  // 1.25× input
    cacheWrite1hMicroCentsPerMTok: 6_000_000,  // 2× input
    cacheReadMicroCentsPerMTok: 300_000,       // 0.10× input
  },
  'claude-haiku-4-5': {
    inputMicroCentsPerMTok: 1_000_000,         // $1.00/M
    outputMicroCentsPerMTok: 5_000_000,        // $5.00/M
    cacheWrite5mMicroCentsPerMTok: 1_250_000,  // 1.25× input
    cacheWrite1hMicroCentsPerMTok: 2_000_000,  // 2× input
    cacheReadMicroCentsPerMTok: 100_000,       // 0.10× input
  },
  // Jina Reader (paid tier) — billed per token returned at $0.02/MTok, via the
  // `uncached` bucket. Caching fields are zero because Jina Reader has no
  // cache tier. Capture the token count from the response (x-total-tokens
  // header when present, else chars/4 fallback) at the call site.
  jina_reader_paid: {
    inputMicroCentsPerMTok: 200_000,           // $0.02/M
    outputMicroCentsPerMTok: 0,
    cacheWrite5mMicroCentsPerMTok: 0,
    cacheWrite1hMicroCentsPerMTok: 0,
    cacheReadMicroCentsPerMTok: 0,
  },
};

/**
 * Flat per-call pricing for non-token services. `perUnitMicroCents` is the
 * charge for one unit (one image, one search, one execution).
 *
 * Judge0 is priced at the RapidAPI Basic overage rate ($0.002/submission).
 * Under the daily free quota the real cost is $0, but billing the overage
 * rate uniformly over-estimates inside the free cap rather than silently
 * under-billing the moment we exceed it.
 */
export const SERVICE_PRICING = {
  bfl_flux_kontext_pro: { perUnitMicroCents: 400_000 },   // $0.04/image
  bfl_flux_dev: { perUnitMicroCents: 250_000 },           // $0.025/image — used for `overview`-tier hero images (cheapest BFL-hosted variant; Schnell is open-weights only via 3rd-party)
  tavily_search_advanced: { perUnitMicroCents: 160_000 }, // 2 credits × $0.008 PAYG = $0.016/query
  judge0_rapidapi: { perUnitMicroCents: 20_000 },         // $0.002/submission (RapidAPI Basic overage)
} as const;

export type ServiceSku = keyof typeof SERVICE_PRICING;

// ── Pricing functions ──────────────────────────────────────

export interface LlmUsageInputs {
  model: string;
  cacheRead: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  uncached: number;
  output: number;
}

const warnedMissingModels = new Set<string>();

/**
 * Compute the microcent cost of a single LLM call from its token breakdown.
 * Integer microcents out; callers that sum this over thousands of calls get
 * a precise allowance total without float drift.
 */
export const priceLlmUsage = ({
  model,
  cacheRead,
  cacheCreation5m,
  cacheCreation1h,
  uncached,
  output,
}: LlmUsageInputs): number => {
  const price = LLM_PRICING[model];
  if (!price) {
    if (!warnedMissingModels.has(model)) {
      warnedMissingModels.add(model);
      console.warn(`[pricing] no LLM_PRICING entry for model "${model}" — cost tracking will return 0 for this model until added`.yellow);
    }
    return 0;
  }
  const perMTok = 1_000_000;
  const cost =
    (uncached * price.inputMicroCentsPerMTok) / perMTok +
    (cacheCreation5m * price.cacheWrite5mMicroCentsPerMTok) / perMTok +
    (cacheCreation1h * price.cacheWrite1hMicroCentsPerMTok) / perMTok +
    (cacheRead * price.cacheReadMicroCentsPerMTok) / perMTok +
    (output * price.outputMicroCentsPerMTok) / perMTok;
  return Math.max(0, Math.round(cost));
};

/**
 * Flat unit pricing (images, searches, execs). `units` defaults to 1.
 */
export const priceFlatUnit = ({ sku, units = 1 }: { sku: ServiceSku; units?: number }): number => {
  const price = SERVICE_PRICING[sku];
  return Math.max(0, Math.round(price.perUnitMicroCents * units));
};
