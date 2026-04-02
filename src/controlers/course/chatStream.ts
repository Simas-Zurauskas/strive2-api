import { EventEmitter } from 'events';
import asyncHandler from 'express-async-handler';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { chatStreamSchema } from './validation';
import { getUserCourse } from '@services/courseDbService';
import { courseDesignAgent } from '@src/lib/ai/agents/courseDesign';
import { sanitizePromptInput } from '@lib/sanitize';
import ChatSessionModel from '@models/ChatSessionModel';

const formatAnswersFromCourse = (answers: Record<string, unknown> | null) =>
  Object.entries(answers ?? {}).map(([questionId, answer]) => ({
    questionId,
    answer: String(answer),
  }));

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
  const courseId = req.params.courseId as string;
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

  const course = await getUserCourse({ userId, courseId });

  if (!course.structure) {
    res.status(400);
    throw new Error('Course structure must be generated before chatting');
  }

  // Sanitize the latest user message
  const lastMessage = rawMessages[rawMessages.length - 1];
  if (lastMessage?.role === 'user') {
    lastMessage.content = sanitizePromptInput(lastMessage.content);
  }

  // Load persisted chat history
  const chatSession = await ChatSessionModel.findOne({ courseId, userId }).lean();
  const history = (chatSession?.messages ?? []) as { role: string; content: string }[];

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
    tokenEmitter.removeAllListeners();
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
