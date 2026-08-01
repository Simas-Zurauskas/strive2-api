import { ChatAnthropic } from '@langchain/anthropic';
import { ANTHROPIC_API_KEY } from '@conf/env';
import { makeLlmCacheCallback } from '@lib/ai/cacheLogger';

// ⚠ No per-user or per-course spend cap is enforced anywhere in this file
// or in the controllers that invoke these models. A malicious or runaway
// client that hammers `/api/course` endpoints can generate arbitrary
// numbers of lessons — each one drives 4+ Sonnet calls. Rate limiting at
// the HTTP layer (see index.ts + authLimiter) caps request rate but not
// tokens-per-user. For production, track a rolling spend window on
// UserGamificationModel (or a new UserUsageModel) and refuse jobs above
// a tier-dependent budget. Out of scope for the current audit pass.

// ── Model IDs (centralized for easy version pinning) ──
// Sonnet 5 migration (2026-08-01, wiki-strive/notes/WORKING/ai-upgrade/):
//   • `temperature` is REJECTED by claude-sonnet-5 (400) — no Sonnet call
//     site may set it. Haiku 4.5 still accepts it.
//   • An omitted `thinking` param means adaptive-ON for Sonnet 5, so every
//     Sonnet call sends an explicit `thinking: {type: 'disabled'}` (also
//     valid on 4.6, keeping rollback a one-line revert of this constant).
//   • The Sonnet 5 tokenizer emits ~1.36× (prose) – 1.44× (code) as many
//     tokens as 4.6 for the same text — maxTokens carry matching headroom.
export const MODEL_IDS = {
  SONNET: 'claude-sonnet-5',
  HAIKU: 'claude-haiku-4-5',
} as const;

// Each model gets its own cache-logging callback with a sensible default
// label. Call sites that share a model (interactiveModel → quiz/interactive;
// utilityModel → links/recall/grading) override per-call via
// `.invoke(input, { metadata: { llmLabel: 'foo:bar' } })`. See
// `lib/ai/cacheLogger.ts`.
//
// Prompt caching is NOT configured at the model level. Anthropic's
// `cache_control` is a per-block attribute — passing it via `invocationKwargs`
// is silently dropped by the API. Call sites that want caching attach it to a
// specific SystemMessage content block via `cachedSystemMessage(...)` from
// `lib/ai/cacheControl.ts`; the Vercel-AI-SDK-based `lesson:content` path
// attaches it via `providerOptions` on the system message. Both land the
// breakpoint on the static prompt, with dynamic per-call content living AFTER
// the breakpoint so every call reuses the cached prefix.

// Clarify questions & depth previews — structured extraction with domain reasoning
const clarifyModel = new ChatAnthropic({
  model: MODEL_IDS.SONNET,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 6144,
  thinking: { type: 'disabled' },
  clientOptions: { timeout: 60000 },
  callbacks: [makeLlmCacheCallback({ defaultLabel: 'clarify:generate', model: MODEL_IDS.SONNET })],
});

// Structure generation — needs strong reasoning, long output, complex constraint adherence
const structureModel = new ChatAnthropic({
  model: MODEL_IDS.SONNET,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 24000,
  thinking: { type: 'disabled' },
  clientOptions: { timeout: 600000 }, // 10 minutes
  callbacks: [makeLlmCacheCallback({ defaultLabel: 'structure:generate', model: MODEL_IDS.SONNET })],
});

// Lesson content generation — best long-form educational writing
const lessonModel = new ChatAnthropic({
  model: MODEL_IDS.SONNET,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 24000,
  thinking: { type: 'disabled' },
  clientOptions: { timeout: 600000 }, // 10 minutes
  callbacks: [makeLlmCacheCallback({ defaultLabel: 'lesson:content', model: MODEL_IDS.SONNET })],
});

// Quiz & exercise generation — needs strong reasoning for understanding-based questions.
// ⚠ Pre-Sonnet-5 this ran temperature 0.6 so retries diverged instead of
// repeating the same structured-output parse failure (Anthropic stringifying
// nested arrays at low temp). Sonnet 5 rejects temperature entirely; we rely
// on its stronger structured output. If the retry seesaw returns, watch
// `interactive_sonnet_escalations_total` / `with_retry_total` and add a
// retry-nonce line AFTER the cached prompt prefix rather than reintroducing
// temperature. (Decision logged in wiki-strive/notes/WORKING/ai-upgrade/.)
const interactiveModel = new ChatAnthropic({
  model: MODEL_IDS.SONNET,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 6144,
  thinking: { type: 'disabled' },
  clientOptions: { timeout: 120000 }, // 2 minutes (Sonnet is slower than Haiku)
  callbacks: [makeLlmCacheCallback({ defaultLabel: 'interactive', model: MODEL_IDS.SONNET })],
});

// Fast structured extraction (link curation, lightweight tasks)
const utilityModel = new ChatAnthropic({
  model: MODEL_IDS.HAIKU,
  temperature: 0,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 4096,
  clientOptions: { timeout: 60000 },
  callbacks: [makeLlmCacheCallback({ defaultLabel: 'utility', model: MODEL_IDS.HAIKU })],
});

export const getClarifyModel = () => clarifyModel;
export const getStructureModel = () => structureModel;
export const getLessonModel = () => lessonModel;
export const getInteractiveModel = () => interactiveModel;
export const getUtilityModel = () => utilityModel;
