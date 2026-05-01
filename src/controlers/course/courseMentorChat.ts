import { EventEmitter } from 'events';
import { Types } from 'mongoose';
import asyncHandler from 'express-async-handler';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { chatStreamSchema } from './validation';
import { getUserCourseLean } from '@services/courseDbService';
import { courseMentorAgent } from '@src/lib/ai/agents/courseMentor';
import { buildCourseSummaryBlock, type LessonStatus } from '@src/lib/ai/agents/courseMentor/prompts';
import { buildHandoffValidationContext } from '@src/lib/ai/agents/shared/emitHandoffTool';
import { runMentorAgentStream } from '@src/lib/ai/agents/shared/runMentorAgentStream';
import { sanitizePromptInput } from '@lib/sanitize';
import { compressMessageHistory } from '@lib/messageCompression';
import { debitActualSpend } from '@services/creditService';
import { bgError } from '@lib/bg';
import { chat } from '@lib/loggers';
import LessonContentModel from '@models/LessonContentModel';
import CourseMentorChatModel from '@models/CourseMentorChatModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import UserInsightProgressModel from '@models/UserInsightProgressModel';
import InsightModel from '@models/InsightModel';


/**
 * Build the per-lesson status map used by the course-summary block.
 *
 * Status precedence (for a given `${moduleIndex}:${lessonIndex}` key):
 *   1. UserLessonProgress.status if a row exists ('completed' |
 *      'in_progress' | 'not_started').
 *   2. Otherwise 'not_started' if the lesson HAS content
 *      (LessonContent.completed=true).
 *   3. Otherwise the key is absent — caller treats as 'not_generated'.
 *
 * Edge case: a learner can have a progress row for a lesson whose
 * content was later regenerated (or deleted). The progress row wins —
 * "you completed lesson X" is still factually accurate even if the
 * stored content has since shifted.
 */
const buildLessonStatusMap = async ({
  userId,
  courseId,
}: {
  userId: string;
  courseId: Types.ObjectId;
}): Promise<Map<string, 'completed' | 'in_progress' | 'not_started'>> => {
  const userObjectId = new Types.ObjectId(userId);

  const [progressRows, contentRows] = await Promise.all([
    UserLessonProgressModel.find({ userId: userObjectId, courseId })
      .select('moduleIndex lessonIndex status')
      .lean(),
    LessonContentModel.find({ courseId, completed: true })
      .select('moduleIndex lessonIndex')
      .lean(),
  ]);

  const result = new Map<string, 'completed' | 'in_progress' | 'not_started'>();

  // Step 1: every generated lesson starts as 'not_started'.
  for (const c of contentRows) {
    result.set(`${c.moduleIndex}:${c.lessonIndex}`, 'not_started');
  }

  // Step 2: progress rows override. A progress row for an ungenerated
  // lesson (rare — content regenerated after progress) still wins, so
  // the mentor reports the learner's actual journey accurately.
  for (const p of progressRows) {
    const status = p.status;
    if (status === 'completed' || status === 'in_progress' || status === 'not_started') {
      result.set(`${p.moduleIndex}:${p.lessonIndex}`, status);
    }
  }

  return result;
};

/**
 * Build the learner-context block — a compact aggregate-progress
 * summary injected after the course structure in the system prompt.
 *
 * Lower-resolution than the `get_user_progress` tool's `course` scope:
 * we want the system prompt to give the mentor *enough* signal to
 * orient without burning thousands of tokens on a structured dump.
 * The tool is for when the mentor needs deeper detail.
 */
const buildCourseLearnerContext = async ({
  userId,
  courseId,
}: {
  userId: string;
  courseId: Types.ObjectId;
}): Promise<string> => {
  const userObjectId = new Types.ObjectId(userId);

  const [lessonProgressRows, moduleQuizzes, insightIds] = await Promise.all([
    UserLessonProgressModel.find({ userId: userObjectId, courseId })
      .select('status completedAt')
      .lean(),
    UserModuleQuizProgressModel.find({ userId: userObjectId, courseId })
      .select('moduleIndex bestScore')
      .lean(),
    InsightModel.distinct('_id', { courseId }) as Promise<Types.ObjectId[]>,
  ]);

  const insightsDue = insightIds.length > 0
    ? await UserInsightProgressModel.countDocuments({
        userId: userObjectId,
        insightId: { $in: insightIds },
        nextDue: { $lte: new Date() },
      })
    : 0;

  const lessonsCompleted = lessonProgressRows.filter((l) => l.status === 'completed').length;

  const lastActivity = lessonProgressRows
    .map((l) => l.completedAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const daysSinceLastActivity = lastActivity
    ? Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const lines: string[] = ['## Learner Progress'];
  lines.push(`- Lessons completed: ${lessonsCompleted}`);
  if (daysSinceLastActivity !== null) {
    lines.push(`- Days since last completed lesson: ${daysSinceLastActivity}`);
  }
  if (moduleQuizzes.length > 0) {
    const scoresByModule = moduleQuizzes
      .map((q) => `Module ${q.moduleIndex + 1}: ${q.bestScore}%`)
      .join(', ');
    lines.push(`- Module quiz scores: ${scoresByModule}`);
  } else {
    lines.push('- Module quizzes: none taken');
  }
  lines.push(`- Insights due across the course: ${insightsDue}`);

  return lines.join('\n');
};

/**
 * @swagger
 * /api/course/{courseId}/mentor/chat:
 *   post:
 *     summary: Stream a chat message for the course-scoped mentor (compass)
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
export const courseMentorChatController = asyncHandler(async (req, res) => {
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

  const parseResult = chatStreamSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ message: parseResult.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }

  const { messages: rawMessages } = parseResult.data;

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  // Sanitize the latest user message (first-turn input is the only place
  // an injection vector could enter; history is server-controlled text).
  const lastMessage = rawMessages[rawMessages.length - 1];
  if (lastMessage?.role === 'user') {
    lastMessage.content = sanitizePromptInput(lastMessage.content);
  }

  // ── Build the course-summary block + learner-context block ──
  const modules = course.structure?.modules ?? [];
  const statusMap = await buildLessonStatusMap({ userId, courseId: course._id });

  const moduleSummaries = modules.map((m, mi) => ({
    title: m.name,
    description: m.description,
    lessons: m.lessons.map((l, li) => {
      const key = `${mi}:${li}`;
      // Explicit annotation so TS keeps the narrow union — without it
      // the inferred type widens to `string` and the spread into
      // ModuleSummary fails type-check at the buildCourseSummaryBlock
      // call below.
      const status: LessonStatus = statusMap.get(key) ?? 'not_generated';
      return { title: l.name, description: l.description, status };
    }),
  }));

  // Per-module count of lessons that have content generated. Derived
  // from the same data backing `statusMap` so we don't requery. Used
  // by `emit_handoff` to validate that a quiz handoff only fires when
  // all lessons in that module are ready.
  const generatedCountByModule = modules.map((m, mi) =>
    m.lessons.reduce((count, _, li) => {
      const status = statusMap.get(`${mi}:${li}`);
      // statusMap entries are present iff the lesson has content; their
      // status value is irrelevant for the count.
      return status !== undefined ? count + 1 : count;
    }, 0),
  );

  const courseSummary = buildCourseSummaryBlock({
    courseGoal: course.goal ?? '',
    courseDepth: course.depth ?? 'comprehensive',
    modules: moduleSummaries,
  });

  const learnerContext = await buildCourseLearnerContext({
    userId,
    courseId: course._id,
  }).catch((e) => {
    chat.warn(`course:turn learnerContext fetch failed err=${e instanceof Error ? e.message : e}`);
    return '';
  });

  // ── Load + compress persisted chat history ──
  const chatSession = await CourseMentorChatModel.findOne({ courseId, userId }).lean();
  const rawHistory = (chatSession?.messages ?? []) as { role: string; content: string }[];
  const { history, newSummary } = await compressMessageHistory({
    history: rawHistory,
    priorSummary: chatSession?.summary,
    summarizationInstruction:
      'Summarize this course-overview conversation in 3-5 bullet points. Focus on: what the learner asked about, what decisions they made (which lesson next, which module to revisit, etc.), and any open questions. Be concise.',
    llmLabel: 'course-mentor:history-compress',
    scope: 'course',
  });

  if (newSummary) {
    await CourseMentorChatModel.updateOne(
      { courseId, userId },
      { $set: { summary: newSummary } },
      { upsert: true },
    ).catch(bgError('courseMentorChat.persistSummary'));
  }

  const newUserMessage = rawMessages[rawMessages.length - 1];

  const historyMessages = history.map((m) =>
    m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content),
  );
  const messages = [
    ...historyMessages,
    ...(newUserMessage ? [new HumanMessage(newUserMessage.content)] : []),
  ];

  const handoffContext = buildHandoffValidationContext({
    modules,
    generatedCountByModule,
  });

  const agentContext = {
    courseId,
    userId,
    courseGoal: course.goal ?? '',
    courseDepth: course.depth ?? 'comprehensive',
    courseSummary,
    learnerContext,
  };

  // ── SSE headers ──────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Content-Encoding', 'none');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('x-vercel-ai-ui-message-stream', 'v1');
  res.flushHeaders();

  const abortController = new AbortController();
  const tokenEmitter = new EventEmitter();
  let clientConnected = true;
  const turnStartedAt = Date.now();

  chat.info(
    `course:turn start course=${courseId} historyMessages=${messages.length} hasSummary=${chatSession?.summary ? 'yes' : 'no'}`,
  );

  res.on('close', () => {
    if (!clientConnected) return;
    clientConnected = false;
    abortController.abort();
    tokenEmitter.removeAllListeners();
    chat.warn(`course:stream client disconnect ms=${Date.now() - turnStartedAt}`);
  });

  const { ok } = await runMentorAgentStream({
    res,
    abortController,
    isClientConnected: () => clientConnected,
    agent: courseMentorAgent,
    agentInput: { messages, ...agentContext },
    agentConfigurable: {
      ...agentContext,
      tokenEmitter,
      abortSignal: abortController.signal,
      handoffContext,
    },
    scope: 'course',
  });

  if (!ok) {
    chat.warn(`course:turn done ok=false ms=${Date.now() - turnStartedAt}`);
    return;
  }
  chat.info(`course:turn done ok=true ms=${Date.now() - turnStartedAt}`);

  // Debit credit spend accumulated during this chat turn. Distinct
  // jobType keeps course-mentor traffic separable from lesson-mentor
  // traffic in the analytics dashboard.
  await debitActualSpend({
    userId,
    jobId: new Types.ObjectId(),
    jobType: 'course_mentor_chat',
  }).catch(bgError('courseMentorChat.debitOnSuccess'));
});
