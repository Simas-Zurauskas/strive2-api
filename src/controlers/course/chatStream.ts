import { EventEmitter } from 'events';
import asyncHandler from 'express-async-handler';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { chatStreamSchema } from './validation';
import { getUserCourseLean } from '@services/courseDbService';
import { courseDesignAgent } from '@src/lib/ai/agents/courseDesign';
import { sanitizePromptInput } from '@lib/sanitize';
import { getUtilityModel } from '@lib/langchain';
import CourseDesignChatModel from '@models/CourseDesignChatModel';

const formatAnswersFromCourse = (answers: Record<string, unknown> | null) =>
  Object.entries(answers ?? {}).map(([questionId, answer]) => ({
    questionId,
    answer: String(answer),
  }));

/** Max history messages before summarization kicks in. */
const HISTORY_WINDOW = 10;
/** Number of recent messages to keep verbatim. */
const KEEP_RECENT = 4;

/**
 * Summarize older chat messages to prevent context window bloat.
 * Returns a condensed history prefix + the recent verbatim messages.
 */
const compressHistory = async (
  history: { role: string; content: string }[],
): Promise<{ role: string; content: string }[]> => {
  if (history.length <= HISTORY_WINDOW) return history;

  const olderMessages = history.slice(0, history.length - KEEP_RECENT);
  const recentMessages = history.slice(history.length - KEEP_RECENT);

  const conversationText = olderMessages
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join('\n\n');

  try {
    const model = getUtilityModel();
    const result = await model.invoke(
      [
        new HumanMessage(
          `Summarize this course design conversation in 3-5 bullet points. Focus on: what structural changes were requested, what was decided, and any important context. Be concise.\n\n${conversationText}`,
        ),
      ],
      { metadata: { llmLabel: 'course:history-compress' } },
    );

    const summary = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    console.log(`[chatStream] Compressed ${olderMessages.length} older messages into summary`.gray);

    return [
      { role: 'assistant', content: `[Summary of earlier conversation]\n${summary}` },
      ...recentMessages,
    ];
  } catch (e) {
    console.warn(`[chatStream] History compression failed, using full history: ${e instanceof Error ? e.message : e}`);
    return history;
  }
};

/** Write a single SSE event compatible with Vercel AI SDK ui-message-stream v1. */
const writeSSE = (res: import('express').Response, payload: Record<string, unknown>) => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

/**
 * @swagger
 * /api/course/{courseId}/chat:
 *   post:
 *     summary: Stream a chat message for course structure refinement
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messages]
 *             properties:
 *               messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant]
 *                     content:
 *                       type: string
 *     responses:
 *       200:
 *         description: SSE stream of chat response
 */
export const chatStreamController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  // AI SDK v3 sends messages with `parts` instead of `content` — normalise
  if (Array.isArray(req.body?.messages)) {
    for (const msg of req.body.messages) {
      if (!msg.content && Array.isArray(msg.parts)) {
        msg.content = msg.parts
          .filter((p: { type: string }) => p.type === 'text')
          .map((p: { text: string }) => p.text)
          .join('');
      }
    }
  }

  // Validate
  const parseResult = chatStreamSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ message: parseResult.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }

  const { messages: rawMessages } = parseResult.data;

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  if (!course.structure) {
    res.status(400);
    throw new Error('Course structure must be generated before chatting');
  }

  // Sanitize the latest user message
  const lastMessage = rawMessages[rawMessages.length - 1];
  if (lastMessage?.role === 'user') {
    lastMessage.content = sanitizePromptInput(lastMessage.content);
  }

  // Load persisted chat history (compress if long to prevent context window bloat)
  const chatSession = await CourseDesignChatModel.findOne({ courseId, userId }).lean();
  const rawHistory = (chatSession?.messages ?? []) as { role: string; content: string }[];
  const history = await compressHistory(rawHistory);

  const newUserMessage = rawMessages[rawMessages.length - 1];

  const historyMessages = history.map((m) =>
    m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content),
  );
  const messages = [
    ...historyMessages,
    ...(newUserMessage ? [new HumanMessage(newUserMessage.content)] : []),
  ];

  // Build course context for tools
  const courseContext = {
    courseId,
    userId,
    goal: course.goal,
    answers: formatAnswersFromCourse(course.answers),
    depth: course.depth ?? 'comprehensive',
    currentStructure: course.structure,
  };

  // ── SSE headers ──────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Content-Encoding', 'none');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('x-vercel-ai-ui-message-stream', 'v1');
  res.flushHeaders();

  // ── Abort controller for cleanup on client disconnect ────
  const abortController = new AbortController();
  let clientConnected = true;

  res.on('close', () => {
    clientConnected = false;
    abortController.abort();
    if (tokenEmitter) tokenEmitter.removeAllListeners();
  });

  // ── Token streaming via EventEmitter ─────────────────────
  // The chat node uses the raw Anthropic SDK and emits tokens here.
  // This bypasses LangChain's broken streaming for ChatAnthropic.
  const tokenEmitter = new EventEmitter();
  let textStarted = false;
  const textPartId = `text-${Date.now()}`;

  tokenEmitter.on('token', (token: string) => {
    if (!token || !clientConnected) return;
    // When text starts streaming, mark any pending tools as complete
    if (!textStarted) {
      for (const tc of pendingToolCalls) {
        writeSSE(res, { type: 'tool-output-available', toolCallId: tc.toolCallId });
      }
      pendingToolCalls.length = 0;
      writeSSE(res, { type: 'text-start', id: textPartId });
      textStarted = true;
    }
    writeSSE(res, { type: 'text-delta', delta: token, id: textPartId });
  });

  const pendingToolCalls: { toolCallId: string; toolName: string }[] = [];

  tokenEmitter.on('tool', ({ toolName, toolCallId }: { toolName: string; toolCallId: string }) => {
    if (!clientConnected) return;
    if (textStarted) {
      writeSSE(res, { type: 'text-end', id: textPartId });
      textStarted = false;
    }
    writeSSE(res, { type: 'tool-input-start', toolCallId, toolName, dynamic: true });
    writeSSE(res, { type: 'tool-input-available', toolCallId, toolName });
    pendingToolCalls.push({ toolCallId, toolName });
  });

  // Run the agent — tokens stream via emitter while agent orchestrates tools/save
  try {
    await courseDesignAgent.invoke(
      { messages, ...courseContext },
      { configurable: { ...courseContext, tokenEmitter, abortSignal: abortController.signal } },
    );
  } catch (err) {
    if (!clientConnected) return; // Client disconnected — nothing to send
    throw err;
  }

  if (!clientConnected) return;

  // Finalize SSE stream — flush any pending tool calls that weren't followed by text
  for (const tc of pendingToolCalls) {
    writeSSE(res, { type: 'tool-output-available', toolCallId: tc.toolCallId });
  }
  pendingToolCalls.length = 0;

  if (textStarted) {
    writeSSE(res, { type: 'text-end', id: textPartId });
  }
  res.write('data: [DONE]\n\n');
  res.end();
});
