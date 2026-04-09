import asyncHandler from 'express-async-handler';
import { Types } from 'mongoose';
import { getUserCourse } from '@services/courseDbService';
import { jobEvents } from '@services/jobEvents';
import { lessonGenerationAgent } from '@lib/ai/agents/lessonGeneration';
import CourseModel from '@models/CourseModel';
import LessonContentModel from '@models/LessonContentModel';
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

  const course = await getUserCourse({ userId, courseId: req.params.courseId as string });
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
  await assertPreviousLessonGenerated(courseId, moduleIndex, lessonIndex, course.structure as { modules: { lessons: unknown[] }[] });

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

  // ── SSE headers ──────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Content-Encoding', 'none');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientConnected = true;
  res.on('close', () => { clientConnected = false; });

  const writeSSE = (payload: Record<string, unknown>) => {
    if (!clientConnected) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  console.log(`[API] Streaming lesson generation (LangGraph), courseId: ${courseId}, module: ${moduleIndex}, lesson: ${lessonIndex}`.cyan);

  try {
    // Invoke the LangGraph agent with custom stream mode
    // Nodes emit events via config.writer → writeSSE → client
    const input = {
      courseId,
      goal: course.goal,
      answers: formatCourseAnswers(course),
      depth: course.depth ?? 'comprehensive',
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
    };

    // Stream with updates mode
    for await (const chunk of await lessonGenerationAgent.stream(input, {
      streamMode: 'updates',
      configurable: {
        writer: trackingWriter,
      },
    })) {
      // Capture summary from content generation node
      if (chunk.contentGeneration) {
        const { contentSummary } = chunk.contentGeneration as { contentSummary?: string };
        if (contentSummary) savedSummary = contentSummary;
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

    // Final save — ensure everything is persisted (flush any pending debounce)
    if (saveTimer) clearTimeout(saveTimer);
    await savePromise;
    await saveToDb();
    console.log(`[API] Final save: ${allBlocks.length} blocks, image: ${!!savedHeroImageUrl}`.gray);

    writeSSE({ type: 'complete' });
    console.log(`[API] Lesson stream complete, courseId: ${courseId}`.green);

    // Notify other clients (e.g. reloaded tabs) via WebSocket
    await CourseModel.findByIdAndUpdate(courseId, { activeJobId: null });
    jobEvents.emit('update', { jobId: 'stream', status: 'completed', courseId, type: 'generate_lesson', userId });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[API] Lesson stream failed: ${message}`.red);
    writeSSE({ type: 'error', message });

    await CourseModel.findByIdAndUpdate(courseId, { activeJobId: null });
    jobEvents.emit('update', { jobId: 'stream', status: 'failed', error: message, courseId, type: 'generate_lesson', userId });
  } finally {
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
