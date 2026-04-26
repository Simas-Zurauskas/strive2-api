/**
 * Enum of paid-action "service" buckets. Each bucket groups call sites that
 * bill against the same upstream provider. New providers (e.g. ElevenLabs for
 * TTS, Replicate for audio transcription) should be added here and in the
 * matching Swagger schema so client and server stay in lockstep.
 *
 * Kept separate from the pricing table so UI code (icons, labels) can import
 * the enum without pulling model-price constants into the client bundle.
 */
export const USAGE_SERVICES = [
  'anthropic', // Claude LLM calls (all models, all three SDKs)
  'bfl',       // Black Forest Labs — Flux Kontext Pro hero images
  'tavily',    // Tavily advanced web search
  'jina',      // Jina Reader — main-content extraction
  'judge0',    // Judge0 — sandboxed code execution
  'tts',       // Google Cloud Text-to-Speech — lesson audio narration
] as const;

export type UsageService = typeof USAGE_SERVICES[number];
