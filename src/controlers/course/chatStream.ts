import { EventEmitter } from 'events';
import { Types } from 'mongoose';
import asyncHandler from 'express-async-handler';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { chatStreamSchema } from './validation';
import { getUserCourseLean } from '@services/courseDbService';
import { courseDesignAgent } from '@src/lib/ai/agents/courseDesign';
import { sanitizePromptInput } from '@lib/sanitize';
import { getUtilityModel } from '@lib/langchain';
import { debitActualSpend } from '@services/creditService';
import { bgError } from '@lib/bg';
import { chatLog } from '@lib/loggers';
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
    chatLog.info(
      `design:compress one-shot summary built — folded ${olderMessages.length} older messages into ${summary.length}c`,
    );

    return [
      { role: 'assistant', content: `[Summary of earlier conversation]\n${summary}` },
      ...recentMessages,
    ];
  } catch (e) {
    chatLog.warn(
      `design:compress summariser failed, using full history err=${e instanceof Error ? e.message : e}`,
    );
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
 *                   $ref: '#/components/schemas/ChatMessage'
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

    // The AI SDK keeps the full conversation in `useChat` state and sends
    // every past message back on each turn. If any past assistant message
    // has `parts` with no text-part (a turn that emitted tool calls without
    // a final text reply, or one the SDK serialized in a way that left no
    // text), the normaliser above produces `content: ''`. The schema
    // (`content: z.string().min(1)`) then 400s the whole request, blocking
    // the new user message from reaching the agent and silently breaking
    // every subsequent turn.
    //
    // The controller uses only `rawMessages[rawMessages.length - 1]` — the
    // history is discarded (server reads its own persisted history from
    // CourseDesignChatModel). So an empty entry in the prior turns is
    // pure noise; drop it. We always preserve the LAST entry so an
    // accidental empty current-turn submission still 400s.
    const original = req.body.messages;
    const filtered = original.filter((m: { content?: unknown }, i: number) => {
      if (i === original.length - 1) return true;
      return typeof m.content === 'string' && m.content.length > 0;
    });
    if (filtered.length !== original.length) {
      chatLog.info(
        `design:turn dropped ${original.length - filtered.length} empty history message(s) before validation`,
      );
      req.body.messages = filtered;
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

  // Build course context for tools + agent state. The depth-recommendation
  // fields below are pulled from `course.depthPreviews` (populated when the
  // depth-previews job ran). All optional — legacy courses persisted before
  // these fields existed leave them undefined and the agent's prompt
  // handles absence gracefully (see prompts.ts § Depth Recommendation).
  //
  // Read defensively (the LLM-emitted fields are `optional()` in
  // depthPreviewsOutputSchema) and pass through only well-typed values
  // so the agent state's typed annotations stay clean.
  const previews = course.depthPreviews as Record<string, unknown> | undefined;
  const readRiskLevel = (v: unknown): 'low' | 'moderate' | 'high' | undefined =>
    v === 'low' || v === 'moderate' || v === 'high' ? v : undefined;
  const readStr = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const readRange = (v: unknown): [number, number] | undefined => {
    if (!Array.isArray(v) || v.length !== 2) return undefined;
    const [a, b] = v;
    return typeof a === 'number' && typeof b === 'number' ? [a, b] : undefined;
  };
  const recommendedDepth = readStr(previews?.recommended);
  const courseContext = {
    courseId,
    userId,
    goal: course.goal,
    answers: formatAnswersFromCourse(course.answers),
    depth: course.depth ?? 'comprehensive',
    currentStructure: course.structure,
    // Optional depth-recommendation context — see prompts.ts.
    recommendedDepth,
    recommendationReason: readStr(previews?.recommendationReason),
    overcommitRisk: readRiskLevel(previews?.overcommitRisk),
    overcommitRationale: readStr(previews?.overcommitRationale),
    undercommitRisk: readRiskLevel(previews?.undercommitRisk),
    undercommitRationale: readStr(previews?.undercommitRationale),
    // Recommended-tier scope ranges live nested under
    // `depthPreviews[recommendedDepth].lessonCountRange / estimatedHoursRange`
    // because the per-tier scope is enriched into each tier's preview
    // object (see enrichDepthPreviewsWithScope in courseService.ts).
    recommendedLessonCountRange: recommendedDepth
      ? readRange(
          (previews?.[recommendedDepth] as Record<string, unknown> | undefined)?.lessonCountRange,
        )
      : undefined,
    recommendedHoursRange: recommendedDepth
      ? readRange(
          (previews?.[recommendedDepth] as Record<string, unknown> | undefined)?.estimatedHoursRange,
        )
      : undefined,
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
  const turnStartedAt = Date.now();

  chatLog.info(
    `design:turn start course=${courseId} historyMessages=${messages.length} structureSet=${course.structure ? 'yes' : 'no'}`,
  );

  res.on('close', () => {
    if (!clientConnected) return;
    clientConnected = false;
    abortController.abort();
    if (tokenEmitter) tokenEmitter.removeAllListeners();
    chatLog.warn(`design:stream client disconnect ms=${Date.now() - turnStartedAt}`);
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
    if (!clientConnected) {
      chatLog.warn(`design:turn aborted post-disconnect ms=${Date.now() - turnStartedAt}`);
      // Still debit — the agent may have consumed tokens before the
      // disconnect, and skipping the debit here is the abuse vector that
      // H3 closes. Threshold forgives near-zero pre-flight failures.
      await debitActualSpend({
        userId,
        jobId: new Types.ObjectId(),
        jobType: 'design_chat',
        minMicroCents: 500,
      }).catch(bgError('chatStream.debit'));
      return;
    }
    chatLog.error(
      `design:turn agent error ms=${Date.now() - turnStartedAt} err=${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }

  if (!clientConnected) {
    chatLog.warn(`design:turn done-but-client-gone ms=${Date.now() - turnStartedAt}`);
    await debitActualSpend({
      userId,
      jobId: new Types.ObjectId(),
      jobType: 'design_chat',
      minMicroCents: 500,
    }).catch(bgError('chatStream.debit'));
    return;
  }

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

  chatLog.info(`design:turn done ok=true ms=${Date.now() - turnStartedAt}`);

  // Debit credit spend accumulated during this chat turn. Mirrors
  // lessonChat.ts — without this the course-design chat is effectively
  // free, since the usageContextMiddleware records spend but nothing
  // hands it to debitActualSpend.
  await debitActualSpend({
    userId,
    jobId: new Types.ObjectId(),
    jobType: 'design_chat',
    minMicroCents: 500,
  }).catch(bgError('chatStream.debit'));
});
