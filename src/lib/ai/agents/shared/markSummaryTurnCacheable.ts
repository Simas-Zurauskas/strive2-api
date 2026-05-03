import type Anthropic from '@anthropic-ai/sdk';
import { CHAT_SUMMARY_PREFIX } from '@lib/messageCompression';

/**
 * If the first message of an Anthropic conversation is the synthetic
 * rolling-summary turn (recognised by `CHAT_SUMMARY_PREFIX`), tag its
 * text block with `cache_control: ephemeral` so the summary hits the
 * Anthropic prompt cache on subsequent turns until the next refresh.
 *
 * The summary turn is built by `messageCompression.ts` as a single
 * assistant text block; after `toAnthropicMessages` it lands as
 * `{ role: 'assistant', content: [{ type: 'text', text: '[Summary…]\n…' }] }`.
 * Mutates in place — the caller already owns the array.
 *
 * No-op when no summary is present (short chat).
 */
export const markSummaryTurnCacheable = (
  messages: Anthropic.Messages.MessageParam[],
): void => {
  const first = messages[0];
  if (!first || first.role !== 'assistant' || !Array.isArray(first.content)) return;
  const block = first.content[0];
  if (!block || block.type !== 'text') return;
  if (!block.text.startsWith(CHAT_SUMMARY_PREFIX)) return;
  block.cache_control = { type: 'ephemeral' };
};
