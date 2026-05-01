import 'colors';
import type { UsageService } from '@lib/usageConstants';

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
 * 2026-04-24. Confirm against the provider dashboards before any of this
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
  // Jina Reader (paid tier) — billed per token returned at $0.05/MTok, via the
  // `uncached` bucket. Caching fields are zero because Jina Reader has no
  // cache tier. Capture the token count from the response (x-total-tokens
  // header when present, else chars/4 fallback) at the call site.
  // Unit: $0.05/MTok = 5¢/MTok = 50,000 μ¢/MTok.
  jina_reader_paid: {
    inputMicroCentsPerMTok: 50_000,            // $0.05/M
    outputMicroCentsPerMTok: 0,
    cacheWrite5mMicroCentsPerMTok: 0,
    cacheWrite1hMicroCentsPerMTok: 0,
    cacheReadMicroCentsPerMTok: 0,
  },
  // OpenAI text-embedding-3-small — $0.02/1M input tokens. 1536 dims,
  // sufficient quality for educational-content retrieval. We use it for
  // lesson chunk indexing (write-side) AND mentor query embedding (read-side).
  // Reconciled against https://openai.com/api/pricing/ on 2026-04-29.
  // Unit: $0.02/MTok = 2¢/MTok = 20,000 μ¢/MTok.
  'openai-text-embedding-3-small': {
    inputMicroCentsPerMTok: 20_000,            // $0.02/M
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
// Unit reminder: 1 cent = 10,000 μ¢. So $0.016 = 1.6¢ = 16,000 μ¢.
// Prior values were 10× inflated (160_000 for Tavily's $0.016 query, etc.) —
// caught because a user's $4 top-up was being eaten by one full lesson with
// image + links, which in reality costs ~$0.45 of real API spend, not ~$1.40.
export const SERVICE_PRICING = {
  bfl_flux_dev: { perUnitMicroCents: 25_000 },           // $0.025/image — the only BFL hero-image model we call
  tavily_search_advanced: { perUnitMicroCents: 16_000 }, // 2 credits × $0.008 PAYG = $0.016/query
  judge0_rapidapi: { perUnitMicroCents: 2_000 },         // $0.002/submission (RapidAPI Basic overage)
  // Pinecone Standard plan (us-east region — lowest of $4-$4.50/M WU and $16-$18/M RU
  // posted ranges). The $50/month plan minimum is a fixed overhead the platform
  // eats; only variable WU/RU usage is allocated to user actions.
  //
  // - 1 WU = 1 KB of an upsert request, 5 WU minimum per request → recorded per upsert.
  // - 1 RU = 1 GB of namespace size touched by a query, 0.25 RU minimum → recorded per
  //   query. We default to the 0.25 RU minimum until namespace exceeds 0.25 GB; at
  //   that point we'd want to fetch describeIndexStats() periodically and scale.
  //
  // Reconciled against pinecone.io/pricing on 2026-04-29.
  pinecone_write_unit: { perUnitMicroCents: 4 },         // $4/M WU → 4 μ¢/WU
  pinecone_read_unit: { perUnitMicroCents: 16 },         // $16/M RU → 16 μ¢/RU
} as const;

/**
 * Per-1M-character pricing for TTS providers. Stored as μ¢ per 1M chars
 * (not per-char) because per-char is sub-microcent for cheap providers
 * (WaveNet at $4/M = 0.4 μ¢/char) and we'd lose precision on flat unit
 * pricing. Use `priceTtsUsage` to compute the cost for a given char count.
 *
 * Numbers reconciled against vendor pricing pages on 2026-04-26.
 */
export const TTS_PRICING = {
  // Google Cloud Text-to-Speech.
  // https://cloud.google.com/text-to-speech/pricing
  // WaveNet/Studio voices billed at $0.000004/char, Neural2 at $0.000016/char.
  google_wavenet: { microCentsPer1MChars: 400_000 },  // $4/M chars
  google_neural2: { microCentsPer1MChars: 1_600_000 }, // $16/M chars (deferred to v2 but priced ahead)
} as const;

export type TtsSku = keyof typeof TTS_PRICING;

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

/**
 * Compute the vendor microcent cost of a TTS synthesis call from its
 * character count. WaveNet's per-character rate is sub-microcent so we
 * scale via the per-1M-chars rate and round up — under-billing here
 * silently eats into our margin once aggregated over thousands of lessons.
 */
export const priceTtsUsage = ({ sku, characters }: { sku: TtsSku; characters: number }): number => {
  if (!Number.isFinite(characters) || characters <= 0) return 0;
  const rate = TTS_PRICING[sku].microCentsPer1MChars;
  return Math.max(0, Math.ceil((characters * rate) / 1_000_000));
};

// ── User-facing markup ─────────────────────────────────────
//
// A flat multiplier applied to the four 3rd-party "premium" services on the
// user-charged side of the ledger. Vendor cost (what we actually pay the
// provider) is unchanged and continues to be recorded on `costMicroCents`;
// the user is debited against `chargedMicroCents = vendor × factor` for these
// services. Anthropic LLM cost — including the LLM-as-judge insight grader —
// flows through 1:1.
//
// Markup is intentionally tier- and balance-source-agnostic: free, paid
// subscription, and top-up bonus credits all see the same factor for these
// services. If we later want a per-tier ratio, branch inside `applyStaticMarkup`
// — every other piece of credit accounting reads through this single helper.
export const STATIC_MARKUP_FACTOR = 2;

export const STATIC_MARKUP_SERVICES: ReadonlySet<UsageService> = new Set<UsageService>([
  'judge0',
  'tavily',
  'jina',
  'bfl',
  'tts',
  'openai',   // OpenAI embeddings — lesson-RAG indexing + mentor search queries
  'pinecone', // Pinecone vector store — WU on upsert, RU on query
]);

export const applyStaticMarkup = ({
  service,
  costMicroCents,
}: {
  service: UsageService;
  costMicroCents: number;
}): number =>
  STATIC_MARKUP_SERVICES.has(service)
    ? Math.max(0, Math.round(costMicroCents * STATIC_MARKUP_FACTOR))
    : costMicroCents;
