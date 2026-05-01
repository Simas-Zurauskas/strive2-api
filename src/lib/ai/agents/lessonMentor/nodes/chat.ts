import Anthropic from '@anthropic-ai/sdk';
import { AIMessage } from '@langchain/core/messages';
import { EventEmitter } from 'events';
import { ANTHROPIC_API_KEY } from '@conf/env';
import { MODEL_IDS } from '@lib/langchain';
import { logCacheUsage, usageFromAnthropic } from '@lib/ai/cacheLogger';
import { chat as chatLog } from '@lib/loggers';
import {
  LESSON_MENTOR_SYSTEM_PROMPT,
  buildAttachmentsBlock,
  buildLessonContextBlock,
} from '../prompts';
import { EMIT_HANDOFF_ANTHROPIC_TOOL } from '../../shared/emitHandoffTool';
import { toAnthropicMessages } from '../../shared/toAnthropicMessages';
import { markSummaryTurnCacheable } from '../../shared/markSummaryTurnCacheable';
import { NodeFunction } from '../types';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const ANTHROPIC_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'web_search',
    description:
      'Search the web for current information about a topic relevant to the lesson. Use when you need to verify a fact, check if something is current, or look up something you are not certain about.',
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
      "Fetch the learner's progress data. Use 'lesson' scope to get their status, quiz responses, and time spent on this lesson. Use 'module' scope to get their module quiz score and how many insights are due for review.",
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['lesson', 'module'],
          description: "'lesson' for this lesson's progress, 'module' for quiz scores and insights due",
        },
      },
      required: ['scope'],
    },
  },
  {
    name: 'search_lesson_content',
    description:
      "Search the course's indexed lesson content via vector similarity. Use when the learner references material from another lesson, asks something that might be in the broader course, or you need to verify a recall against the source material. Returns up to 5 ranked chunks with their lesson/module location.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The natural-language question or concept to search for.' },
        moduleIndex: {
          type: 'number',
          description: 'Optional: restrict search to a specific module index. Omit to search the entire course.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description:
      "Fetch the main-text content of a public web page via Jina Reader. Use when the learner pastes a URL (article, paper, doc) and asks you to read or discuss it, OR when you genuinely need to read external material to answer their question accurately. Returns up to 8K chars of extracted text. Do NOT use for course-internal questions — prefer search_lesson_content for those.",
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'A fully-qualified http(s) URL of a public web page.' },
      },
      required: ['url'],
    },
  },
  EMIT_HANDOFF_ANTHROPIC_TOOL,
];

export const chat: NodeFunction = async (state, config) => {
  const invokeStart = Date.now();
  chatLog.info(
    `lesson:chat invoke model=${MODEL_IDS.HAIKU} stateMessages=${state.messages.length}`,
  );

  const contextBlock = buildLessonContextBlock({
    lessonTitle: state.lessonTitle,
    moduleTitle: state.moduleTitle,
    courseGoal: state.courseGoal,
    courseDepth: state.courseDepth,
    lessonContent: state.lessonContent,
    learnerContext: state.learnerContext ?? '',
  });

  const attachmentsBlock = buildAttachmentsBlock({ attachments: state.attachments ?? [] });

  const anthropicMessages = toAnthropicMessages(state.messages);
  markSummaryTurnCacheable(anthropicMessages);

  const tokenEmitter = config?.configurable?.tokenEmitter as EventEmitter | undefined;
  const abortSignal = config?.configurable?.abortSignal as AbortSignal | undefined;

  // System block layout (cached top-down):
  //   1. Static persona prompt — never changes; cached at the boundary
  //      between block 1 and block 2 since block 2 has cache_control.
  //   2. Lesson context — changes per-lesson; cached.
  //   3. Attachments — changes when the session adds/removes files;
  //      cached. **Omitted entirely** when there are no attachments so
  //      we don't burn a cache miss on a no-op block in the common case.
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: LESSON_MENTOR_SYSTEM_PROMPT },
    { type: 'text', text: contextBlock, cache_control: { type: 'ephemeral' } },
  ];
  if (attachmentsBlock) {
    systemBlocks.push({
      type: 'text',
      text: attachmentsBlock,
      cache_control: { type: 'ephemeral' },
    });
  }

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

  logCacheUsage({ label: 'mentor:chat', usage: usageFromAnthropic(response), model: MODEL_IDS.HAIKU });

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
    `lesson:chat response ms=${Date.now() - invokeStart} text=${textContent.length}c tool_calls=${toolCalls.length}${toolCalls.length > 0 ? ` tools=[${toolCalls.map((tc) => tc.name).join(',')}]` : ''}`,
  );

  return { messages: [aiMessage] };
};
