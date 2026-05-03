import Anthropic from '@anthropic-ai/sdk';
import { AIMessage } from '@langchain/core/messages';
import { ANTHROPIC_API_KEY } from '@conf/env';
import { MODEL_IDS } from '@lib/langchain';
import { logCacheUsage, usageFromAnthropic } from '@lib/ai/cacheLogger';
import { chatLog } from '@lib/loggers';
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
  {
    name: 'search_product_kb',
    description:
      "Search Strive's help center for facts about the platform itself: billing, credits, plans, how spaced review/mastery works, what Strive is good at, what features exist. Use ONLY for product-meta questions about Strive — NEVER to source course content. Returns up to 3 excerpts with article href; cite via inline markdown links.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language question about how Strive works as a platform.',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * Render the optional Depth Recommendation block. Returns an empty string
 * when no recommendation context is available (legacy courses) — the
 * system prompt handles absence gracefully so we don't need to fabricate
 * a placeholder block.
 *
 * Format mirrors the markdown style of the rest of the context summary
 * so the agent reads it as one continuous brief.
 */
const buildDepthRecommendationBlock = (state: {
  depth?: string;
  recommendedDepth?: string;
  recommendationReason?: string;
  overcommitRisk?: 'low' | 'moderate' | 'high';
  overcommitRationale?: string;
  undercommitRisk?: 'low' | 'moderate' | 'high';
  undercommitRationale?: string;
  recommendedLessonCountRange?: [number, number];
  recommendedHoursRange?: [number, number];
}): string => {
  // Skip the entire block when nothing meaningful is present (legacy
  // course). A bare "Recommended: undefined" block would just confuse
  // the agent and waste a cache slot.
  if (!state.recommendedDepth && !state.recommendationReason) return '';

  const lines: string[] = ['', '', '## Depth Recommendation'];
  if (state.recommendedDepth) {
    lines.push(`- Selected: ${state.depth ?? 'N/A'}`);
    lines.push(`- Recommended: ${state.recommendedDepth}`);
    lines.push(
      `- Match: ${state.depth === state.recommendedDepth ? 'yes' : 'no'}`,
    );
  }
  if (state.recommendedLessonCountRange) {
    const [lo, hi] = state.recommendedLessonCountRange;
    lines.push(`- Recommended-tier scope: ${lo}–${hi} lessons`);
  }
  if (state.recommendedHoursRange) {
    const [lo, hi] = state.recommendedHoursRange;
    lines.push(`- Recommended-tier hours: ~${lo}–${hi} hours`);
  }
  if (state.recommendationReason) {
    lines.push(`- Why: ${state.recommendationReason}`);
  }
  if (state.overcommitRisk) {
    lines.push(
      `- Overcommit risk: ${state.overcommitRisk}` +
        (state.overcommitRationale ? ` — ${state.overcommitRationale}` : ''),
    );
  }
  if (state.undercommitRisk) {
    lines.push(
      `- Undercommit risk: ${state.undercommitRisk}` +
        (state.undercommitRationale ? ` — ${state.undercommitRationale}` : ''),
    );
  }
  return lines.join('\n');
};

const buildStructureSummary = (state: {
  goal?: string;
  depth?: string;
  answers?: { questionId: string; answer: string }[];
  currentStructure?: {
    modules: { name: string; description: string; lessons: { name: string; description: string }[] }[];
  };
  recommendedDepth?: string;
  recommendationReason?: string;
  overcommitRisk?: 'low' | 'moderate' | 'high';
  overcommitRationale?: string;
  undercommitRisk?: 'low' | 'moderate' | 'high';
  undercommitRationale?: string;
  recommendedLessonCountRange?: [number, number];
  recommendedHoursRange?: [number, number];
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

  const depthBlock = buildDepthRecommendationBlock(state);

  return `\n\n## Current Course Context\n- Goal: ${state.goal ?? 'N/A'}\n- Depth: ${state.depth ?? 'N/A'}\n- Modules: ${modules.length}\n- Total lessons: ${totalLessons}${answersText}${depthBlock}\n\n${structureText}`;
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
