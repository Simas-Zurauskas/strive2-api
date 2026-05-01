import Anthropic from '@anthropic-ai/sdk';
import { AIMessage } from '@langchain/core/messages';
import { ANTHROPIC_API_KEY } from '@conf/env';
import { MODEL_IDS } from '@lib/langchain';
import { logCacheUsage, usageFromAnthropic } from '@lib/ai/cacheLogger';
import { chat as chatLog } from '@lib/loggers';
import { COURSE_DESIGN_SYSTEM_PROMPT } from '../prompts';
import { toAnthropicMessages } from '../../shared/toAnthropicMessages';
import { NodeFunction } from '../types';
import { EventEmitter } from 'events';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/** Convert LangChain tools to Anthropic tool format with proper JSON schemas. */
const ANTHROPIC_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'modify_structure',
    description:
      'Modifies the course structure based on a natural language instruction. Use this when the user asks to add, remove, reorder, merge, split, or change modules or lessons.',
    input_schema: {
      type: 'object' as const,
      properties: {
        instruction: {
          type: 'string',
          description: 'A clear, specific instruction for how to modify the course structure.',
        },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for current information about technologies, frameworks, best practices, or any topic relevant to course design.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
      },
      required: ['query'],
    },
  },
];

const buildStructureSummary = (state: {
  goal?: string;
  depth?: string;
  answers?: { questionId: string; answer: string }[];
  currentStructure?: {
    modules: { name: string; description: string; lessons: { name: string; description: string }[] }[];
  };
}): string => {
  const modules = state.currentStructure?.modules ?? [];
  if (modules.length === 0) return '';

  const totalLessons = modules.reduce((sum, m) => sum + m.lessons.length, 0);

  const structureText = modules
    .map(
      (m, i) =>
        `Module ${i + 1}: ${m.name}\n  ${m.description}\n  Lessons:\n${m.lessons.map((l, j) => `    ${j + 1}. ${l.name} — ${l.description}`).join('\n')}`,
    )
    .join('\n\n');

  const answersText = state.answers?.length
    ? `\n- Learner answers:\n${state.answers.map((a) => `  - ${a.questionId}: ${a.answer}`).join('\n')}`
    : '';

  return `\n\n## Current Course Context\n- Goal: ${state.goal ?? 'N/A'}\n- Depth: ${state.depth ?? 'N/A'}\n- Modules: ${modules.length}\n- Total lessons: ${totalLessons}${answersText}\n\n${structureText}`;
};

export const chat: NodeFunction = async (state, config) => {
  const invokeStart = Date.now();
  chatLog.info(`design:chat invoke model=${MODEL_IDS.SONNET} stateMessages=${state.messages.length}`);

  const structureSummary = buildStructureSummary(state);
  const anthropicMessages = toAnthropicMessages(state.messages);

  // Get the token emitter and abort signal from configurable context (set by the endpoint)
  const tokenEmitter = config?.configurable?.tokenEmitter as EventEmitter | undefined;
  const abortSignal = config?.configurable?.abortSignal as AbortSignal | undefined;

  // System prompt with cache_control — static prompt + course context cached separately
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [{ type: 'text', text: COURSE_DESIGN_SYSTEM_PROMPT }];
  if (structureSummary) {
    // Course context changes per course but stays stable within a conversation
    systemBlocks.push({ type: 'text', text: structureSummary, cache_control: { type: 'ephemeral' } });
  } else {
    // No structure yet — cache the system prompt itself
    systemBlocks[0].cache_control = { type: 'ephemeral' };
  }

  const stream = anthropic.messages.stream(
    {
      model: MODEL_IDS.SONNET,
      max_tokens: 4096,
      temperature: 0.7,
      system: systemBlocks,
      messages: anthropicMessages,
      tools: ANTHROPIC_TOOLS,
    },
    { signal: abortSignal },
  );

  // Emit tokens as they arrive
  stream.on('text', (text) => {
    tokenEmitter?.emit('token', text);
  });

  // Emit tool use events for UI badges
  stream.on('contentBlock', (block) => {
    if (block.type === 'tool_use') {
      tokenEmitter?.emit('tool', { toolName: block.name, toolCallId: block.id });
    }
  });

  const response = await stream.finalMessage();

  logCacheUsage({ label: 'course:chat', usage: usageFromAnthropic(response), model: MODEL_IDS.SONNET });

  // Convert Anthropic response to LangChain AIMessage
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
    `design:chat response ms=${Date.now() - invokeStart} text=${textContent.length}c tool_calls=${toolCalls.length}${toolCalls.length > 0 ? ` tools=[${toolCalls.map((tc) => tc.name).join(',')}]` : ''}`,
  );

  return { messages: [aiMessage] };
};
