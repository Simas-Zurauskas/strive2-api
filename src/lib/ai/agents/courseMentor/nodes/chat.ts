import Anthropic from '@anthropic-ai/sdk';
import { AIMessage } from '@langchain/core/messages';
import { EventEmitter } from 'events';
import { ANTHROPIC_API_KEY } from '@conf/env';
import { MODEL_IDS } from '@lib/langchain';
import { logCacheUsage, usageFromAnthropic } from '@lib/ai/cacheLogger';
import { chatLog } from '@lib/loggers';
import { COURSE_MENTOR_SYSTEM_PROMPT } from '../prompts';
import { EMIT_HANDOFF_ANTHROPIC_TOOL } from '../../shared/emitHandoffTool';
import { toAnthropicMessages } from '../../shared/toAnthropicMessages';
import { markSummaryTurnCacheable } from '../../shared/markSummaryTurnCacheable';
import { NodeFunction } from '../types';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/**
 * Anthropic-side tool schemas for the course mentor.
 *
 * Mirrors the lesson mentor's three reusable tools (web_search,
 * get_user_progress, search_lesson_content) but with course-scope
 * descriptions:
 *   - get_user_progress now accepts scope='course' (extended in
 *     lessonMentor/tools.ts to support all three scopes).
 *   - search_lesson_content is the PRIMARY tool here — most
 *     cross-module questions require retrieval since no lesson content
 *     is injected into this agent's system prompt.
 *
 * NOT included: fetch_url (rare at this scope) and emit_handoff
 * (added in v2 — see api/src/lib/ai/agents/shared/emitHandoffTool.ts).
 */
const ANTHROPIC_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'web_search',
    description:
      'Search the web for current information about a topic relevant to the course. Use only when you need external facts the course content does not cover. Prefer search_lesson_content for anything course-internal.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_user_progress',
    description:
      "Fetch the learner's progress data. Use 'course' scope to get the full picture (per-module quiz scores, recall cards due grouped by module, lessons completed). Use 'module' for a single module, 'lesson' for one lesson — but at course scope you usually want 'course'.",
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['lesson', 'module', 'course'],
          description:
            "'course' for the whole-course picture; 'module' for one module; 'lesson' for one lesson. moduleIndex required for 'module', moduleIndex+lessonIndex for 'lesson'.",
        },
        moduleIndex: {
          type: 'number',
          description: "Required when scope='module' or scope='lesson'.",
        },
        lessonIndex: {
          type: 'number',
          description: "Required when scope='lesson'.",
        },
      },
      required: ['scope'],
    },
  },
  {
    name: 'search_lesson_content',
    description:
      "Search the course's indexed lesson content via vector similarity. This is the PRIMARY tool at course scope — the system prompt does NOT inject lesson content, so use this whenever the learner asks a question about specific lesson material, cross-module connections, or anything that requires citing actual content. Returns up to 5 ranked chunks with their lesson/module location.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The natural-language question or concept to search for.' },
        moduleIndex: {
          type: 'number',
          description:
            'Optional: restrict search to a specific module index. Omit to search the entire course.',
        },
      },
      required: ['query'],
    },
  },
  EMIT_HANDOFF_ANTHROPIC_TOOL,
];

export const chat: NodeFunction = async (state, config) => {
  const invokeStart = Date.now();
  chatLog.info(`course:chat invoke model=${MODEL_IDS.HAIKU} stateMessages=${state.messages.length}`);

  // The course-summary block ALREADY includes course goal + depth + the
  // full module/lesson tree with per-lesson status. The learnerContext
  // block (built by the controller) carries aggregated progress signals
  // — quiz scores per module, recall cards due, days since last activity.
  // Both are deterministic per `(courseId, userId, course state)` so
  // they cache turn-to-turn.
  const contextBlock = state.learnerContext
    ? `${state.courseSummary}\n\n${state.learnerContext}`
    : state.courseSummary;

  const anthropicMessages = toAnthropicMessages(state.messages);
  markSummaryTurnCacheable(anthropicMessages);

  const tokenEmitter = config?.configurable?.tokenEmitter as EventEmitter | undefined;
  const abortSignal = config?.configurable?.abortSignal as AbortSignal | undefined;

  // System block layout (cached top-down):
  //   1. Static persona prompt — never changes; the cache_control on
  //      block 2 establishes the cached prefix that includes block 1.
  //   2. Course context — modules + lessons + progress; changes
  //      occasionally (when structure refines or learner progresses)
  //      but stable across consecutive turns; cached.
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: COURSE_MENTOR_SYSTEM_PROMPT },
    { type: 'text', text: contextBlock, cache_control: { type: 'ephemeral' } },
  ];

  const stream = anthropic.messages.stream(
    {
      model: MODEL_IDS.HAIKU,
      max_tokens: 2048,
      temperature: 0.7,
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

  logCacheUsage({ label: 'course-mentor:chat', usage: usageFromAnthropic(response), model: MODEL_IDS.HAIKU });

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
    `course:chat response ms=${Date.now() - invokeStart} text=${textContent.length}c tool_calls=${toolCalls.length}${toolCalls.length > 0 ? ` tools=[${toolCalls.map((tc) => tc.name).join(',')}]` : ''}`,
  );

  return { messages: [aiMessage] };
};
