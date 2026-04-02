import asyncHandler from 'express-async-handler';
import { Types } from 'mongoose';
import { getUserCourse } from '@services/courseDbService';
import { generateLessonContentStreaming } from '@services/lessonService';
import CourseModel from '@models/CourseModel';
import LessonContentModel from '@models/LessonContentModel';
import { generateLessonSchema } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/stream-lesson:
 *   post:
 *     summary: Generate and stream lesson content via SSE
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
  const courseId = req.params.courseId as string;
  const userId = req.userId!;
  const { moduleIndex, lessonIndex } = generateLessonSchema.parse(req.body);

  const course = await getUserCourse({ userId, courseId });

  // Validate lesson exists
  if (!course.structure?.modules) {
    res.status(400);
    throw new Error('Course has no structure yet');
  }
  const mod = course.structure.modules[moduleIndex];
  if (!mod) { res.status(400); throw new Error(`Module ${moduleIndex} does not exist`); }
  const lesson = mod.lessons?.[lessonIndex];
  if (!lesson) { res.status(400); throw new Error(`Lesson ${lessonIndex} does not exist in module ${moduleIndex}`); }

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

  console.log(`[API] Streaming lesson generation, courseId: ${courseId}, module: ${moduleIndex}, lesson: ${lessonIndex}`.cyan);

  try {
    const result = await generateLessonContentStreaming(
      {
        goal: course.goal,
        answers: formatCourseAnswers(course),
        depth: course.depth ?? 'comprehensive',
        structure: course.structure as {
          modules: { name: string; description: string; lessons: { name: string; description: string }[] }[];
        },
        moduleIndex,
        lessonIndex,
      },
      {
        onContentBlocks: (blocks, summary) => {
          writeSSE({ type: 'blocks', blocks });
        },
        onInteractiveBlocks: (blocks) => {
          writeSSE({ type: 'blocks', blocks });
        },
        onHeroImage: (url) => {
          writeSSE({ type: 'hero_image', url });
        },
        onLinksBlock: (block) => {
          writeSSE({ type: 'blocks', blocks: [block] });
        },
      },
    );

    // ── Save to DB ────────────────────────────────────
    const existing = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });
    await LessonContentModel.findOneAndUpdate(
      { courseId, moduleIndex, lessonIndex },
      {
        courseId,
        moduleIndex,
        lessonIndex,
        blocks: result.blocks,
        summary: result.summary,
        heroImageUrl: result.heroImageUrl,
        version: existing ? existing.version + 1 : 1,
      },
      { upsert: true, returnDocument: 'after' },
    );

    writeSSE({ type: 'complete' });
    console.log(`[API] Lesson stream complete, courseId: ${courseId}`.green);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[API] Lesson stream failed: ${message}`.red);
    writeSSE({ type: 'error', message });
  } finally {
    // Always clear the guard
    await CourseModel.findByIdAndUpdate(courseId, { activeJobId: null });
    res.end();
  }
});

// ── Helper (duplicated from jobRunner to avoid circular import) ──

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
