import asyncHandler from 'express-async-handler';
import { Types } from 'mongoose';
import { getUserCourseLean } from '@services/courseDbService';
import { jobEvents } from '@services/jobEvents';
import { lessonGenerationAgent } from '@lib/ai/agents/lessonGeneration';
import CourseModel from '@models/CourseModel';
import LessonContentModel from '@models/LessonContentModel';
import InsightModel from '@models/InsightModel';
import { GeneratedInsight, persistLessonInsights } from '@services/insightContentService';
import { deleteByPrefix } from '@services/s3Service';
import { bgError } from '@lib/bg';
import { bumpSseStreamEnded, bumpSseStreamStarted } from '@lib/metrics';
import { generateLessonSchema, assertPreviousLessonGenerated } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/stream-lesson:
 *   post:
 *     summary: Generate and stream lesson content via SSE (block-by-block)
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
 *             required: [moduleIndex, lessonIndex]
 *             properties:
 *               moduleIndex:
 *                 type: integer
 *                 minimum: 0
 *               lessonIndex:
 *                 type: integer
 *                 minimum: 0
 *     responses:
 *       200:
 *         description: SSE stream of lesson generation events
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
export const streamLessonContentController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { moduleIndex, lessonIndex, includeImage, includeLinks } = generateLessonSchema.parse(req.body);

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  // Validate lesson exists
  if (!course.structure?.modules) {
    res.status(400);
    throw new Error('Course has no structure yet');
  }
  const mod = course.structure.modules[moduleIndex];
  if (!mod) { res.status(400); throw new Error(`Module ${moduleIndex} does not exist`); }
  const lesson = mod.lessons?.[lessonIndex];
  if (!lesson) { res.status(400); throw new Error(`Lesson ${lessonIndex} does not exist in module ${moduleIndex}`); }

  // Enforce sequential generation — previous lesson must exist
  await assertPreviousLessonGenerated({
    courseId,
    moduleIndex,
    lessonIndex,
    structure: course.structure as { modules: { lessons: unknown[] }[] },
  });

  // ── Atomic guard: one generation at a time per course ──
  const guarded = await CourseModel.findOneAndUpdate(
    { _id: courseId, $or: [{ activeJobId: null }, { activeJobId: { $exists: false } }] },
    { activeJobId: new Types.ObjectId() },
    { returnDocument: 'after' },
  );
  if (!guarded) {
    res.status(409);
    throw new Error('A generation is already running for this course. Please wait.');
  }

  // Everything from header setup through the LangGraph stream happens inside
  // a single try/catch whose finally clears activeJobId. The previous
  // structure had SSE header setup + jobEvents.emit between the guard and
  // the try block; any throw in that window (e.g., `res.setHeader` after a
  // subtle proxy rewrite, or a synchronous listener throwing) would leave
  // the course permanently locked. Moving them inside the try folds those
  // paths into the same cleanup.
  let clientConnected = true;

  // AbortController threaded into `lessonGenerationAgent.stream()` so two
  // different failure modes can stop the agent from burning tokens and BFL
  // image generations uselessly:
  //   1. Client disconnect (tab closed, network dropped) — detected via
  //      `res.on('close')` below.
  //   2. Severe SSE backpressure — if the Node writable buffer grows past
  //      our watermark (5 MB) the consumer isn't keeping up; we abort
  //      rather than let allBlocks + the writable buffer accumulate into a
  //      process-wide memory bomb.
  // AbortErrors raised downstream are caught and treated as a normal
  // teardown path in the `catch` block.
  const abortController = new AbortController();
  const BACKPRESSURE_WATERMARK_BYTES = 5 * 1024 * 1024;

  const writeSSE = (payload: Record<string, unknown>) => {
    if (!clientConnected || abortController.signal.aborted) return;

    // If the writable buffer is already oversized, the client is slow or
    // the socket is stalled. Abort the agent run so we don't keep feeding
    // it; the catch block will clean up the partial lesson.
    if (res.writableLength > BACKPRESSURE_WATERMARK_BYTES) {
      console.warn(
        `[API] SSE backpressure watermark exceeded (${res.writableLength} bytes), aborting stream`.yellow,
      );
      abortController.abort();
      return;
    }

    // `res.write` returns false when the socket buffer is full. We don't
    // synchronously wait for `drain` (the LangGraph writer contract is
    // sync), but the watermark check above catches the pathological case
    // where `drain` never fires because the client vanished.
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    // Counter for the /metrics scraper — paired with the decrement in the
    // finally block so "active streams" = started - ended at any instant.
    bumpSseStreamStarted();

    // Notify clients (including other tabs) which lesson is generating
    jobEvents.emit('started', { jobId: 'stream', courseId, type: 'generate_lesson', userId, moduleIndex, lessonIndex });

    // ── SSE headers ──────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Content-Encoding', 'none');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.on('close', () => {
      clientConnected = false;
      // Cancel the LangGraph run immediately — no point finishing blocks
      // that won't be delivered, and the in-flight Anthropic / BFL / Tavily
      // calls will unwind on the shared signal.
      if (!abortController.signal.aborted) {
        console.log(`[API] Client disconnected mid-stream, aborting agent`.gray);
        abortController.abort();
      }
    });

    console.log(`[API] Streaming lesson generation (LangGraph), courseId: ${courseId}, module: ${moduleIndex}, lesson: ${lessonIndex}`.cyan);

    // Invoke the LangGraph agent with custom stream mode
    // Nodes emit events via config.writer → writeSSE → client
    const input = {
      courseId,
      goal: course.goal,
      answers: formatCourseAnswers(course),
      depth: course.depth ?? 'comprehensive',
      domain: course.domain ?? null,
      structure: course.structure as {
        modules: { name: string; description: string; lessons: { name: string; description: string }[] }[];
      },
      moduleIndex,
      lessonIndex,
      includeImage,
      includeLinks,
    };

    // Track all blocks for incremental DB save
    const allBlocks: unknown[] = [];
    let savedHeroImageUrl: string | null = null;
    let savedSummary = '';
    // Insights arrive as a batch from the insightGeneration node — persist after
    // the lesson itself is saved so we have a valid LessonContent._id to FK to.
    let pendingInsights: GeneratedInsight[] = [];

    // Save to DB — called after each block arrives so content survives page reload
    const saveToDb = async () => {
      await LessonContentModel.findOneAndUpdate(
        { courseId, moduleIndex, lessonIndex },
        {
          courseId,
          moduleIndex,
          lessonIndex,
          blocks: allBlocks,
          summary: savedSummary,
          heroImageUrl: savedHeroImageUrl,
          includeHeroImage: includeImage,
        },
        { upsert: true, returnDocument: 'after' },
      );
    };

    // Debounce DB saves — don't save on every single block (too many writes)
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let savePromise: Promise<void> = Promise.resolve();
    const debouncedSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        savePromise = saveToDb().catch((e) => console.error('[API] DB save failed:', e));
      }, 500);
    };

    // Writer that both sends SSE AND tracks blocks for DB
    const trackingWriter = (event: Record<string, unknown>) => {
      writeSSE(event);

      if (event.type === 'block') {
        allBlocks.push(event.block);
        debouncedSave();
      } else if (event.type === 'hero_image') {
        savedHeroImageUrl = (event.s3Key as string) || (event.url as string);
        debouncedSave();
      }
      // 'insight' events are informational (for future live-preview UIs);
      // the authoritative persistence happens via the insights chunk below.
    };

    // Stream with updates mode (5-minute timeout to prevent hanging on API stalls)
    const STREAM_TIMEOUT_MS = 5 * 60 * 1000;
    const streamPromise = (async () => {
      for await (const chunk of await lessonGenerationAgent.stream(input, {
        streamMode: 'updates',
        // Shared abort signal — propagates to every in-flight LLM call and
        // the stream iterator itself via LangGraph's RunnableConfig.
        signal: abortController.signal,
        configurable: {
          writer: trackingWriter,
        },
      })) {
        // Capture summary from content generation node
        if (chunk.contentGeneration) {
          const { contentSummary } = chunk.contentGeneration as { contentSummary?: string };
          if (contentSummary) savedSummary = contentSummary;
        }

        // Capture the final insight set from the insight generation node.
        if (chunk.insightGeneration) {
          const { insights } = chunk.insightGeneration as { insights?: GeneratedInsight[] };
          if (insights) pendingInsights = insights;
        }

        // Content is validated — send placeholders for interactive blocks so client can show skeletons
        if (chunk.contentValidation) {
          const contentBlocks = allBlocks as { type: string; order: number }[];
          const sections = contentBlocks.filter((b) => b.type === 'section');
          const summaryBlock = contentBlocks.find((b) => b.type === 'summary');
          const maxOrder = Math.max(...contentBlocks.map((b) => b.order));

          // Quiz placeholders: after the last 2 sections (or fewer if less sections)
          const quizSections = sections.slice(-2);
          const quizPlaceholders = quizSections.map((s, i) => ({
            type: 'quiz' as const,
            order: s.order + 0.5,
            id: `placeholder-quiz-${i}`,
          }));

          // Exercise placeholder: just before summary (deterministic)
          const exerciseOrder = summaryBlock ? summaryBlock.order - 0.5 : maxOrder + 1;
          const exercisePlaceholder = { type: 'exercise' as const, order: exerciseOrder, id: 'placeholder-exercise' };

          writeSSE({
            type: 'content_ready',
            placeholders: [...quizPlaceholders, exercisePlaceholder],
          });
        }
      }
    })();

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Lesson generation timed out after 5 minutes')), STREAM_TIMEOUT_MS),
    );

    await Promise.race([streamPromise, timeoutPromise]);

    // Final save — ensure everything is persisted (flush any pending debounce)
    if (saveTimer) clearTimeout(saveTimer);
    await savePromise;
    await saveToDb();
    await LessonContentModel.findOneAndUpdate(
      { courseId, moduleIndex, lessonIndex },
      { completed: true },
    );
    console.log(`[API] Final save: ${allBlocks.length} blocks, image: ${!!savedHeroImageUrl}`.gray);

    // Persist insights after the lesson row exists (FK target). Best-effort —
    // insights are additive enrichment; a failure here must not fail the lesson.
    if (pendingInsights.length > 0) {
      try {
        const persistedIds = await persistLessonInsights({
          courseId,
          moduleIndex,
          lessonIndex,
          insights: pendingInsights,
        });
        writeSSE({ type: 'insights_saved', count: persistedIds.length });
      } catch (e) {
        console.warn(`[API] Insight persistence failed: ${e instanceof Error ? e.message : e}`.yellow);
      }
    }

    writeSSE({ type: 'complete' });
    console.log(`[API] Lesson stream complete, courseId: ${courseId}`.green);

    // Notify other clients (e.g. reloaded tabs) via WebSocket
    await CourseModel.findByIdAndUpdate(courseId, { activeJobId: null });
    jobEvents.emit('update', { jobId: 'stream', status: 'completed', courseId, type: 'generate_lesson', userId, moduleIndex, lessonIndex });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Distinguish user-initiated abort (client closed tab, backpressure
    // watermark hit) from a real failure. The cleanup + activeJobId clear
    // still run either way — the partial lesson should never persist —
    // but we don't want AbortErrors to look like a bug in logs.
    const isAbort =
      abortController.signal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message)));

    if (isAbort) {
      console.log(`[API] Lesson stream aborted: ${message}`.gray);
    } else {
      console.error(`[API] Lesson stream failed: ${message}`.red);
      writeSSE({ type: 'error', message });
    }

    // Clean up incomplete content and S3 assets from failed generation.
    // Insights for this lesson are also removed so a retry gets a clean slate.
    await LessonContentModel.deleteOne({ courseId, moduleIndex, lessonIndex, completed: false });
    InsightModel.deleteMany({ courseId, moduleIndex, lessonIndex }).catch(bgError('streamLesson.cleanupInsights'));
    deleteByPrefix(`lessons/${courseId}/${moduleIndex}/${lessonIndex}/`).catch(bgError('streamLesson.cleanupS3'));

    await CourseModel.findByIdAndUpdate(courseId, { activeJobId: null });
    // Emit a failure event so other tabs / the reviewsDue bell clear their
    // "generating" state. Abort path uses 'failed' too because downstream
    // clients just need to know the run ended without a completion.
    jobEvents.emit('update', {
      jobId: 'stream', status: 'failed', error: isAbort ? 'aborted' : message,
      courseId, type: 'generate_lesson', userId, moduleIndex, lessonIndex,
    });
  } finally {
    // Pair with bumpSseStreamStarted above. Incremented on every exit path
    // (success, error, abort) — the `/metrics` gauge reads the delta.
    bumpSseStreamEnded();
    res.end();
  }
});

// ── Helper ───────────────────────────────────────────

const formatCourseAnswers = (course: { answers?: Record<string, unknown> | null; clarifyData?: { questions: { id: string; question: string }[] } | null }): { questionId: string; answer: string }[] => {
  if (!course.answers || !course.clarifyData?.questions) return [];
  return Object.entries(course.answers).map(([id, answer]) => {
    const question = course.clarifyData!.questions.find((q) => q.id === id);
    return {
      questionId: question?.question ?? id,
      answer: Array.isArray(answer) ? answer.join(', ') : String(answer),
    };
  });
};
