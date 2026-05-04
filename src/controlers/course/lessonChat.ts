import { EventEmitter } from 'events';
import { Types } from 'mongoose';
import asyncHandler from 'express-async-handler';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { chatStreamSchema } from './validation';
import { getUserCourseLean } from '@services/courseDbService';
import { lessonMentorAgent } from '@src/lib/ai/agents/lessonMentor';
import { buildHandoffValidationContext } from '@src/lib/ai/agents/shared/emitHandoffTool';
import { runMentorAgentStream } from '@src/lib/ai/agents/shared/runMentorAgentStream';
import { sanitizePromptInput } from '@lib/sanitize';
import { compressMessageHistory } from '@lib/messageCompression';
import { debitActualSpend } from '@services/creditService';
import { bgError } from '@lib/bg';
import { chatLog } from '@lib/loggers';
import LessonMentorChatModel from '@models/LessonMentorChatModel';
import LessonContentModel from '@models/LessonContentModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import UserRecallProgressModel from '@models/UserRecallProgressModel';
import RecallCardModel from '@models/RecallCardModel';

/** Format lesson blocks as markdown for system prompt injection. */
const blocksToMarkdown = (
  blocks: { type: string; content: string; order: number }[],
): string => {
  return blocks
    .filter((b) => ['intro', 'section', 'code', 'callout', 'summary'].includes(b.type))
    .sort((a, b) => a.order - b.order)
    .map((b) => {
      if (b.type === 'code') return `\`\`\`\n${b.content}\n\`\`\``;
      if (b.type === 'callout') return `> ${b.content}`;
      return b.content;
    })
    .join('\n\n');
};

/** Fetch learner progress and format as a compact context string for the system prompt. */
const buildLearnerContext = async ({
  userId,
  courseId,
  moduleIndex,
  lessonIndex,
}: {
  userId: string;
  courseId: Types.ObjectId;
  moduleIndex: number;
  lessonIndex: number;
}): Promise<string> => {
  const userObjectId = new Types.ObjectId(userId);

  const [lessonProgress, quizProgress, recallCardIds] = await Promise.all([
    UserLessonProgressModel.findOne({ userId: userObjectId, courseId, moduleIndex, lessonIndex })
      .select('status completedAt timeSpentSeconds')
      .lean(),
    UserModuleQuizProgressModel.findOne({ userId: userObjectId, courseId, moduleIndex })
      .select('bestScore bestTier nextReviewAt')
      .lean(),
    RecallCardModel.distinct('_id', { courseId, moduleIndex, lessonIndex }) as Promise<Types.ObjectId[]>,
  ]);

  const recallDue = recallCardIds.length > 0
    ? await UserRecallProgressModel.countDocuments({
        userId: userObjectId,
        recallCardId: { $in: recallCardIds },
        nextDue: { $lte: new Date() },
      })
    : 0;

  const lines: string[] = ['## Learner Progress'];
  lines.push(`- Lesson status: ${lessonProgress?.status ?? 'not_started'}`);

  if (quizProgress) {
    const reviewDue = quizProgress.nextReviewAt && quizProgress.nextReviewAt <= new Date();
    lines.push(
      `- Module quiz: ${quizProgress.bestScore}% (${quizProgress.bestTier ?? 'attempted'})${reviewDue ? ' — review due' : ''}`,
    );
  } else {
    lines.push('- Module quiz: not taken');
  }

  lines.push(`- Recall cards due for review from this lesson: ${recallDue}`);

  return lines.join('\n');
};

export const lessonChatController = asyncHandler(async (req, res) => {
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

    // Drop empty-content history messages before validation. The AI SDK
    // keeps the full conversation in client state and sends every past
    // message back; an assistant turn whose parts had no text-part (tool-
    // only intermediate, or an SDK serialization quirk) normalises to
    // `content: ''` above and then trips `z.string().min(1)`. We use only
    // the LAST message anyway (server reads its own history from
    // LessonMentorChatModel), so empty entries upstream are pure noise.
    // Always preserve the last message so an empty current-turn submission
    // still 400s correctly.
    const original = req.body.messages;
    const filtered = original.filter((m: { content?: unknown }, i: number) => {
      if (i === original.length - 1) return true;
      return typeof m.content === 'string' && m.content.length > 0;
    });
    if (filtered.length !== original.length) {
      chatLog.info(
        `lesson:turn dropped ${original.length - filtered.length} empty history message(s) before validation`,
      );
      req.body.messages = filtered;
    }
  }

  const parseResult = chatStreamSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ message: parseResult.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }

  const { messages: rawMessages, attachmentIds: rawAttachmentIds } = parseResult.data;

  const moduleIndex = parseInt(req.params.moduleIndex as string, 10);
  const lessonIndex = parseInt(req.params.lessonIndex as string, 10);

  if (isNaN(moduleIndex) || isNaN(lessonIndex)) {
    res.status(400).json({ message: 'Invalid moduleIndex or lessonIndex' });
    return;
  }

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  // Sanitize the latest user message
  const lastMessage = rawMessages[rawMessages.length - 1];
  if (lastMessage?.role === 'user') {
    lastMessage.content = sanitizePromptInput(lastMessage.content);
  }

  // Resolve lesson and module metadata from course structure
  const modules = course.structure?.modules ?? [];
  const moduleData = modules[moduleIndex];
  const lessonData = moduleData?.lessons?.[lessonIndex];
  const lessonTitle = lessonData?.name ?? `Lesson ${lessonIndex + 1}`;
  const moduleTitle = moduleData?.name ?? `Module ${moduleIndex + 1}`;

  // Fetch learner progress context (non-blocking — falls back to empty string on error)
  const learnerContext = await buildLearnerContext({
    userId,
    courseId: course._id,
    moduleIndex,
    lessonIndex,
  }).catch((e) => {
    chatLog.warn(`lesson:turn learnerContext fetch failed err=${e instanceof Error ? e.message : e}`);
    return '';
  });

  // Load lesson content blocks (may not exist if lesson not generated yet)
  // AND in parallel, count generated lessons per module so emit_handoff
  // can validate that a quiz handoff only fires when all lessons in
  // that module are ready.
  const [lessonContent, generatedLessonCoords] = await Promise.all([
    LessonContentModel.findOne({
      courseId: course._id,
      moduleIndex,
      lessonIndex,
      completed: true,
    })
      .select('blocks')
      .lean(),
    LessonContentModel.find({
      courseId: course._id,
      completed: true,
    })
      .select('moduleIndex')
      .lean(),
  ]);

  const lessonMarkdown = lessonContent?.blocks
    ? blocksToMarkdown(lessonContent.blocks as { type: string; content: string; order: number }[])
    : '';

  const generatedCountByModule = modules.map(
    (_, mi) => generatedLessonCoords.filter((c) => c.moduleIndex === mi).length,
  );

  // Load and compress persisted chat history
  const chatSession = await LessonMentorChatModel.findOne({
    courseId,
    userId,
    moduleIndex,
    lessonIndex,
  }).lean();
  const rawHistory = (chatSession?.messages ?? []) as { role: string; content: string }[];
  const { history, newSummary } = await compressMessageHistory({
    history: rawHistory,
    priorSummary: chatSession?.summary,
    summarizationInstruction:
      'Summarize this tutoring conversation in 3-5 bullet points. Focus on: what concepts were discussed, what the learner understood or struggled with, and any key questions asked. Be concise.',
    llmLabel: 'mentor:history-compress',
    scope: 'lesson',
  });

  if (newSummary) {
    await LessonMentorChatModel.updateOne(
      { courseId, userId, moduleIndex, lessonIndex },
      { $set: { summary: newSummary } },
      { upsert: true },
    ).catch(bgError('lessonChat.persistSummary'));
  }

  // Validate that any attachmentIds on this turn actually exist on the
  // session. Defence-in-depth — the client should only send ids it
  // received from the attach endpoint, but a stale or malicious client
  // could try to inject random ids; we filter to known attachments only
  // so the saved per-message pointer can never reference a missing
  // session entry.
  const sessionAttachments = chatSession?.attachments ?? [];
  const knownAttachmentIds = new Set(sessionAttachments.map((a) => a.id));
  const pendingAttachmentIds = (rawAttachmentIds ?? []).filter((id) => knownAttachmentIds.has(id));
  if ((rawAttachmentIds?.length ?? 0) > 0 && pendingAttachmentIds.length === 0) {
    chatLog.warn(
      `lesson:turn dropping ${rawAttachmentIds?.length} attachmentId(s) — all unknown for this session`,
    );
  }

  const newUserMessage = rawMessages[rawMessages.length - 1];

  const historyMessages = history.map((m) =>
    m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content),
  );
  const messages = [
    ...historyMessages,
    ...(newUserMessage ? [new HumanMessage(newUserMessage.content)] : []),
  ];

  const agentContext = {
    courseId,
    userId,
    moduleIndex,
    lessonIndex,
    lessonTitle,
    moduleTitle,
    courseGoal: course.goal ?? '',
    lessonContent: lessonMarkdown,
    courseDepth: course.depth ?? 'comprehensive',
    learnerContext,
    // Pass ALL session attachments (not just this turn's) so the model
    // can reference files attached on prior turns. This is the cached
    // system block; constant across the session unless attachments
    // change. Trim to just the fields the chat node needs.
    attachments: sessionAttachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      kind: a.kind,
      approxTokens: a.approxTokens,
      text: a.text,
    })),
    // Per-turn pointer set — saveMessages decorates the new user
    // message with these refs so chips render on rehydration.
    pendingAttachmentIds,
  };

  const handoffContext = buildHandoffValidationContext({
    modules,
    generatedCountByModule,
  });

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

  chatLog.info(
    `lesson:turn start course=${courseId} module=${moduleIndex} lesson=${lessonIndex} historyMessages=${messages.length} attachments=${sessionAttachments.length} hasSummary=${chatSession?.summary ? 'yes' : 'no'} pendingAttachments=${pendingAttachmentIds.length}`,
  );

  res.on('close', () => {
    if (!clientConnected) return;
    clientConnected = false;
    abortController.abort();
    tokenEmitter.removeAllListeners();
    chatLog.warn(`lesson:stream client disconnect ms=${Date.now() - turnStartedAt}`);
  });

  const { ok } = await runMentorAgentStream({
    res,
    abortController,
    isClientConnected: () => clientConnected,
    agent: lessonMentorAgent,
    agentInput: { messages, ...agentContext },
    agentConfigurable: {
      ...agentContext,
      tokenEmitter,
      abortSignal: abortController.signal,
      handoffContext,
    },
    scope: 'lesson',
  });

  if (!ok) {
    chatLog.warn(`lesson:turn done ok=false ms=${Date.now() - turnStartedAt}`);
    return;
  }
  chatLog.info(`lesson:turn done ok=true ms=${Date.now() - turnStartedAt}`);

  // Debit credit spend accumulated during this chat turn
  await debitActualSpend({
    userId,
    jobId: new Types.ObjectId(),
    jobType: 'mentor_chat',
  }).catch(bgError('lessonChat.debitOnSuccess'));
});
