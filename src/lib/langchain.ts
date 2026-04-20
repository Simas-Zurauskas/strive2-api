import { ChatAnthropic } from '@langchain/anthropic';
import { ANTHROPIC_API_KEY } from '@conf/env';

// ⚠ No per-user or per-course spend cap is enforced anywhere in this file
// or in the controllers that invoke these models. A malicious or runaway
// client that hammers `/api/course` endpoints can generate arbitrary
// numbers of lessons — each one drives 4+ Sonnet calls. Rate limiting at
// the HTTP layer (see index.ts + authLimiter) caps request rate but not
// tokens-per-user. For production, track a rolling spend window on
// UserGamificationModel (or a new UserUsageModel) and refuse jobs above
// a tier-dependent budget. Out of scope for the current audit pass.

// ── Model IDs (centralized for easy version pinning) ──
export const MODEL_IDS = {
  SONNET: 'claude-sonnet-4-6',
  HAIKU: 'claude-haiku-4-5',
} as const;

// Clarify questions & depth previews — structured extraction with domain reasoning
const clarifyModel = new ChatAnthropic({
  model: MODEL_IDS.SONNET,
  temperature: 0.7,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 4096,
  clientOptions: { timeout: 60000 },
  invocationKwargs: { cache_control: { type: 'ephemeral' } },
});

// Structure generation — needs strong reasoning, long output, complex constraint adherence
const structureModel = new ChatAnthropic({
  model: MODEL_IDS.SONNET,
  temperature: 0.7,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 16384,
  clientOptions: { timeout: 600000 }, // 10 minutes
  invocationKwargs: { cache_control: { type: 'ephemeral' } },
});

// Lesson content generation — best long-form educational writing, slight creativity
const lessonModel = new ChatAnthropic({
  model: MODEL_IDS.SONNET,
  temperature: 0.3,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 16384,
  clientOptions: { timeout: 600000 }, // 10 minutes
  invocationKwargs: { cache_control: { type: 'ephemeral' } },
});

// Quiz & exercise generation — needs strong reasoning for understanding-based questions.
// Temp 0.6 gives retries enough divergence to escape repeated structured-output parse
// failures (e.g. Anthropic stringifying nested arrays when it hits the same prompt at
// low temp); lower values caused every retry to produce the same broken output.
const interactiveModel = new ChatAnthropic({
  model: MODEL_IDS.SONNET,
  temperature: 0.6,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 4096,
  clientOptions: { timeout: 120000 }, // 2 minutes (Sonnet is slower than Haiku)
  invocationKwargs: { cache_control: { type: 'ephemeral' } },
});

// Fast structured extraction (link curation, lightweight tasks)
const utilityModel = new ChatAnthropic({
  model: MODEL_IDS.HAIKU,
  temperature: 0,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 4096,
  clientOptions: { timeout: 60000 },
  invocationKwargs: { cache_control: { type: 'ephemeral' } },
});

export const getClarifyModel = () => clarifyModel;
export const getStructureModel = () => structureModel;
export const getLessonModel = () => lessonModel;
export const getInteractiveModel = () => interactiveModel;
export const getUtilityModel = () => utilityModel;
