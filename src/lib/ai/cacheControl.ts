/**
 * Helpers for attaching Anthropic `cache_control` breakpoints to LangChain
 * messages.
 *
 * Why this exists: Anthropic's prompt cache is per-block, not per-request.
 * `cache_control` must be set on a specific content block (system, user, or
 * tool-result) inside the message array — not as a top-level invocation
 * option. Passing it via `invocationKwargs` on a `ChatAnthropic` instance is
 * silently dropped by the API (unknown top-level param), which is exactly
 * how this codebase had been "configuring" cache until now.
 *
 * The shape LangChain-Anthropic forwards unchanged to Anthropic is the
 * content-blocks shape on a message:
 *
 *   new SystemMessage({
 *     content: [{ type: 'text', text: '...', cache_control: { type: 'ephemeral' } }],
 *   })
 *
 * Use `cachedSystemMessage` for the common case — a single static system
 * prompt that we want cached so every subsequent call with the same prefix
 * reads it instead of re-tokenizing. Dynamic per-call content (goals,
 * learner answers, lesson metadata) MUST go in a following `HumanMessage`
 * so it is NOT inside the cached prefix — otherwise each call ships a
 * unique prefix and nothing reuses.
 *
 * TTL: defaults to '5m' (1.25× input cost on write, 0.1× on read). Use '1h'
 * (2× write, still 0.1× read) when the same cached prefix is reused more
 * than ~3 times within the hour — e.g. across the many lesson-gen calls
 * that make up one course-generation burst. Below ~3 reads the extra write
 * premium outweighs the extended hit window.
 *
 * Minimum cache sizes at the time of writing: 1024 tokens for Sonnet-class
 * models, 2048 for Haiku-class. Below those, the breakpoint is silently
 * ignored by Anthropic (no write, no premium — just a no-op). This helper
 * emits a one-time warning when the prompt is too small even for Sonnet so
 * the silent no-op surfaces instead of hiding.
 */

import { SystemMessage } from '@langchain/core/messages';
import { llmLog } from '@lib/loggers';

/** Conservative char→token estimate (Anthropic BPE averages ~3.5-4 chars/token). */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const SONNET_MIN_CACHE_TOKENS = 1024;

const warnedSubMin = new Set<string>();

/**
 * Build a SystemMessage whose single text block is marked for caching.
 *
 * The cached prefix is everything up to AND INCLUDING this block; place
 * dynamic content in a following HumanMessage so it lives after the
 * breakpoint.
 *
 * `ttl` picks the ephemeral bucket: '5m' (default) or '1h'. Pricing for both
 * lives in `lib/pricing.ts`; the Vercel-AI and raw-SDK paths forward the
 * field unchanged to the Anthropic API.
 */
export const cachedSystemMessage = ({
  text,
  ttl = '5m',
}: {
  text: string;
  ttl?: '5m' | '1h';
}): SystemMessage => {
  const estimated = estimateTokens(text);
  if (estimated < SONNET_MIN_CACHE_TOKENS) {
    const key = text.slice(0, 64);
    if (!warnedSubMin.has(key)) {
      warnedSubMin.add(key);
      llmLog.warn(
        `cacheControl:sub-min tokens~${estimated} threshold=${SONNET_MIN_CACHE_TOKENS} — cache_control is a silent no-op for this prompt`,
      );
    }
  }
  const cacheControl: { type: 'ephemeral'; ttl?: '1h' } = { type: 'ephemeral' };
  if (ttl === '1h') cacheControl.ttl = '1h';
  return new SystemMessage({
    content: [{ type: 'text', text, cache_control: cacheControl }],
  });
};
