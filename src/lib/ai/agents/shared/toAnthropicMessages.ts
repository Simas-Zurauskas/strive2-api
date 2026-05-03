import type Anthropic from '@anthropic-ai/sdk';

/**
 * Convert LangChain-style messages to Anthropic's `messages` format.
 *
 * Shared between every agent that streams against the raw Anthropic SDK
 * (courseDesign, courseMentor, lessonMentor). Previously this was
 * duplicated in three files; the divergent copies meant any future
 * change to the alternation rule (see below) had to be made in every
 * file or one would silently regress.
 *
 * **Critical correctness rule:** when an assistant turn issued multiple
 * `tool_use` blocks, the corresponding `tool_result` blocks MUST be
 * delivered in a SINGLE user message (Anthropic's strict alternation
 * contract — one assistant turn ↔ one user response per turn).
 * Emitting each ToolMessage as its own user message produces a
 * malformed conversation; Anthropic responds with empty content /
 * 2-token stop-only replies, which manifests as "thinking… then
 * nothing" in the chat. Consecutive ToolMessages are batched.
 */
export interface LangchainLikeMessage {
  _getType: () => string;
  content: unknown;
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[];
  tool_call_id?: string;
  name?: string;
}

export const toAnthropicMessages = (
  messages: LangchainLikeMessage[],
): Anthropic.Messages.MessageParam[] => {
  const result: Anthropic.Messages.MessageParam[] = [];

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const type = m._getType();

    if (type === 'human') {
      result.push({
        role: 'user',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
      i++;
    } else if (type === 'ai') {
      const blocks: Anthropic.Messages.ContentBlockParam[] = [];
      const textContent = typeof m.content === 'string' ? m.content : '';
      if (textContent) {
        blocks.push({ type: 'text', text: textContent });
      }
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        }
      }
      if (blocks.length > 0) {
        result.push({ role: 'assistant', content: blocks });
      }
      i++;
    } else if (type === 'tool') {
      const toolBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];
      while (i < messages.length && messages[i]._getType() === 'tool') {
        const t = messages[i];
        toolBlocks.push({
          type: 'tool_result',
          tool_use_id: t.tool_call_id as string,
          content: typeof t.content === 'string' ? t.content : JSON.stringify(t.content),
        });
        i++;
      }
      if (toolBlocks.length > 0) {
        result.push({ role: 'user', content: toolBlocks });
      }
    } else {
      // Unknown message type — skip defensively.
      i++;
    }
  }

  return result;
};
