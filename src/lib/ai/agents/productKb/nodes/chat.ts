import Anthropic from '@anthropic-ai/sdk';
import { AIMessage } from '@langchain/core/messages';
import { EventEmitter } from 'events';
import { ANTHROPIC_API_KEY } from '@conf/env';
import { MODEL_IDS } from '@lib/langchain';
import { logCacheUsage, usageFromAnthropic } from '@lib/ai/cacheLogger';
import { chatLog } from '@lib/loggers';
import { toAnthropicMessages } from '../../shared/toAnthropicMessages';
import { PRODUCT_KB_SYSTEM_PROMPT } from '../prompts';
import { NodeFunction } from '../types';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const ANTHROPIC_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'search_product_kb',
    description:
      'Search the Strive product knowledge base via vector similarity. Use for any question about Strive features, pricing, billing, account, learning techniques, course creation, lessons, mentor chat, or product behavior. Returns up to 5 excerpts with article title, section heading, and href — cite via inline markdown links in your reply.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language question or concept. Phrase as the visitor would.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for current external information. Use ONLY when the question is not covered by the product KB AND is genuinely external. Prefer search_product_kb for any product question.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch the main-text content of a public web page via Jina Reader. Use when the visitor pastes a URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'A fully-qualified http(s) URL of a public web page.' },
      },
      required: ['url'],
    },
  },
];

export const chat: NodeFunction = async (state, config) => {
  const invokeStart = Date.now();
  chatLog.info(
    `pkb:chat invoke model=${MODEL_IDS.HAIKU} stateMessages=${state.messages.length}`,
  );

  const anthropicMessages = toAnthropicMessages(state.messages);
  const tokenEmitter = config?.configurable?.tokenEmitter as EventEmitter | undefined;
  const abortSignal = config?.configurable?.abortSignal as AbortSignal | undefined;

  // Single static system block — no per-turn context to inject. Cached
  // because the same prompt fronts every visitor's turns; one cache slot
  // earns its keep across the whole help-center traffic.
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: PRODUCT_KB_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];

  const stream = anthropic.messages.stream(
    {
      model: MODEL_IDS.HAIKU,
      max_tokens: 2048,
      temperature: 0.5,
      system: systemBlocks,
      messages: anthropicMessages,
      tools: ANTHROPIC_TOOLS,
    },
    { signal: abortSignal },
  );

  stream.on('text', (text) => {
    tokenEmitter?.emit('token', text);
  });

  stream.on('contentBlock', (block) => {
    if (block.type === 'tool_use') {
      tokenEmitter?.emit('tool', { toolName: block.name, toolCallId: block.id });
    }
  });

  const response = await stream.finalMessage();

  logCacheUsage({ label: 'productKb:chat', usage: usageFromAnthropic(response), model: MODEL_IDS.HAIKU });

  let textContent = '';
  const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input as Record<string, unknown>,
      });
    }
  }

  const aiMessage = new AIMessage({
    content: textContent,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
      type: 'tool_call' as const,
    })),
  });

  chatLog.info(
    `pkb:chat response ms=${Date.now() - invokeStart} text=${textContent.length}c tool_calls=${toolCalls.length}${toolCalls.length > 0 ? ` tools=[${toolCalls.map((tc) => tc.name).join(',')}]` : ''}`,
  );

  return { messages: [aiMessage] };
};
