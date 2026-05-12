import { llmLog } from '@lib/loggers';

/**
 * Vendor pricing tables. All amounts in microcents (1¢ = 10_000 μ¢) so
 * sub-cent token costs stay integer-precise when summed over millions of rows.
 * Reconciled against vendor pricing pages on 2026-04-24 — confirm dashboards
 * before this gates real billing.
 */

export interface LlmPrice {
  inputMicroCentsPerMTok: number;
  outputMicroCentsPerMTok: number;
  cacheWrite5mMicroCentsPerMTok: number;
  cacheWrite1hMicroCentsPerMTok: number;
  cacheReadMicroCentsPerMTok: number;
}

// Keys for Claude match MODEL_IDS in lib/langchain.ts. jina_reader_paid lives
// here (not SERVICE_PRICING) because it bills per token returned. Missing keys
// log once and return 0 — loud rather than silently under-billing.
export const LLM_PRICING: Record<string, LlmPrice> = {
  'claude-sonnet-4-6': {
    inputMicroCentsPerMTok: 3_000_000,
    outputMicroCentsPerMTok: 15_000_000,
    cacheWrite5mMicroCentsPerMTok: 3_750_000,
    cacheWrite1hMicroCentsPerMTok: 6_000_000,
    cacheReadMicroCentsPerMTok: 300_000,
  },
  'claude-haiku-4-5': {
    inputMicroCentsPerMTok: 1_000_000,
    outputMicroCentsPerMTok: 5_000_000,
    cacheWrite5mMicroCentsPerMTok: 1_250_000,
    cacheWrite1hMicroCentsPerMTok: 2_000_000,
    cacheReadMicroCentsPerMTok: 100_000,
  },
  // Jina Reader (paid) bills per token returned via the `uncached` bucket
  // ($0.05/MTok). Capture x-total-tokens header at the call site.
  jina_reader_paid: {
    inputMicroCentsPerMTok: 50_000,
    outputMicroCentsPerMTok: 0,
    cacheWrite5mMicroCentsPerMTok: 0,
    cacheWrite1hMicroCentsPerMTok: 0,
    cacheReadMicroCentsPerMTok: 0,
  },
  'openai-text-embedding-3-small': {
    inputMicroCentsPerMTok: 20_000,
    outputMicroCentsPerMTok: 0,
    cacheWrite5mMicroCentsPerMTok: 0,
    cacheWrite1hMicroCentsPerMTok: 0,
    cacheReadMicroCentsPerMTok: 0,
  },
};

// Flat per-call pricing for non-token services. Judge0 uses the RapidAPI
// Basic overage rate ($0.002/submission) — over-estimates inside the free
// quota rather than silently under-billing once we exceed it.
// Pinecone: 1 WU = 1 KB upsert (5 WU min/request); 1 RU = 1 GB namespace
// touched per query (0.25 RU min). Bump the RU floor if a namespace exceeds
// 0.25 GB via describeIndexStats().
export const SERVICE_PRICING = {
  bfl_flux_dev: { perUnitMicroCents: 25_000 },
  tavily_search_basic: { perUnitMicroCents: 8_000 },
  judge0_rapidapi: { perUnitMicroCents: 2_000 },
  pinecone_write_unit: { perUnitMicroCents: 4 },
  pinecone_read_unit: { perUnitMicroCents: 16 },
} as const;

// Per-1M-chars (not per-char) because cheap providers are sub-microcent
// per character. Use priceTtsUsage to convert to a vendor cost.
export const TTS_PRICING = {
  google_wavenet: { microCentsPer1MChars: 400_000 },
  google_neural2: { microCentsPer1MChars: 1_600_000 },
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
      llmLog.warn(`pricing:missing-model model="${model}" — cost tracking returns 0 until added to LLM_PRICING`);
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

export const priceFlatUnit = ({ sku, units = 1 }: { sku: ServiceSku; units?: number }): number => {
  const price = SERVICE_PRICING[sku];
  return Math.max(0, Math.round(price.perUnitMicroCents * units));
};

// ceil — under-billing sub-microcent rates aggregates into real margin loss.
export const priceTtsUsage = ({ sku, characters }: { sku: TtsSku; characters: number }): number => {
  if (!Number.isFinite(characters) || characters <= 0) return 0;
  const rate = TTS_PRICING[sku].microCentsPer1MChars;
  return Math.max(0, Math.ceil((characters * rate) / 1_000_000));
};

import { PRICING_CONFIG, markupCategoryForAction } from './pricingConfig';
import type { ActionCategory, CreditBucket } from './pricingConfig';

export type { ActionCategory, CreditBucket };

export const markupFor = ({
  action,
  creditBucket,
}: {
  action: string;
  creditBucket: CreditBucket;
}): number => PRICING_CONFIG.markup[markupCategoryForAction(action)][creditBucket];

export const applyMarkup = ({
  action,
  creditBucket,
  costMicroCents,
}: {
  action: string;
  creditBucket: CreditBucket;
  costMicroCents: number;
}): number => {
  if (!Number.isFinite(costMicroCents) || costMicroCents <= 0) return 0;
  const factor = markupFor({ action, creditBucket });
  return Math.max(0, Math.round(costMicroCents * factor));
};
