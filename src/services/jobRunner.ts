import pLimit from 'p-limit';
import JobModel from '@models/JobModel';
import CourseModel, { CourseDocument } from '@models/CourseModel';
import LessonContentModel from '@models/LessonContentModel';
import { JobType, CourseDepth } from '@lib/constants';
import { lessonGenerationAgent } from '@lib/ai/agents/lessonGeneration';
import { quizGenerationAgent } from '@lib/ai/agents/quizGeneration';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import { clarifyCourse, generateCourseStructure, refineCourseStructure, generateDepthPreviews, isThinFreeText } from './courseService';
import { cleanupCourseContent } from './courseCleanupService';
import { persistLessonInsights } from './insightContentService';
import { jobEvents } from './jobEvents';
import { bgError } from '@lib/bg';
import {
  bumpLessonGenerationOutcome,
  bumpStructureThinFreeTextInput,
  recordLessonGenerationDuration,
  type LessonGenerationOutcome,
} from '@lib/metrics';
import { generateUniqueSlug } from '@lib/slugify';

// ── Concurrency & timeout ───────────────────────────────


const MAX_JOB_CONCURRENCY = 50;
const JOB_TIMEOUT_MS = 600_000; // 10 minutes

export const jobLimit = pLimit(MAX_JOB_CONCURRENCY);

const jobTimeout = ({ ms, jobId }: { ms: number; jobId: string }) =>
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Job ${jobId} timed out after ${ms / 1000}s`)), ms),
  );

// ── Helpers ─────────────────────────────────────────────

const formatCourseAnswers = (course: CourseDocument): { questionId: string; answer: string }[] => {
  if (!course.answers || !course.clarifyData?.questions) return [];
  return Object.entries(course.answers as Record<string, unknown>).map(([id, answer]) => {
    const question = course.clarifyData!.questions.find((q) => q.id === id);
    const answerStr = Array.isArray(answer) ? answer.join(', ') : String(answer);
    // Tag thin text replies so the structure-generation prompt can branch
    // toward conservative scope. Only applies to `type === 'text'` answers:
    // a 2-token multiple-choice selection like "Beginner" is semantically
    // OK (level gates are just as informative at 1 token as at 10), but a
    // 2-token free-text reply like "stop overspending" is a weak signal
    // the structure prompt should not over-read.
    const isThinText = question?.type === 'text' && isThinFreeText(answerStr);
    if (isThinText) bumpStructureThinFreeTextInput();
    return {
      questionId: question?.question ?? id,
      answer: isThinText ? `${answerStr} [thin answer — weak signal]` : answerStr,
    };
  });
};

// ── Types ──────────────────────────────────────────────────

interface SubmitJobParams {
  userId: string;
  courseId: string;
  type: JobType;
  metadata?: Record<string, unknown>;
}

// ── Submit ─────────────────────────────────────────────────

export const submitJob = async (params: SubmitJobParams): Promise<string> => {
  // Create the Job document first, then atomically claim the course slot with
  // the real job id. The previous pattern wrote a placeholder ObjectId to
  // `course.activeJobId` and then overwrote it — which meant (a) clients that
  // polled /job/:jobId during the placeholder window got a 404, and (b) if
  // JobModel.create() threw after the guard, the placeholder was never
  // cleared and the course stayed permanently locked.
  const job = await JobModel.create({
    userId: params.userId,
    courseId: params.courseId,
    type: params.type,
    status: 'pending',
    ...(params.metadata && { metadata: params.metadata }),
  });

  const claimed = await CourseModel.findOneAndUpdate(
    {
      _id: params.courseId,
      $or: [{ activeJobId: null }, { activeJobId: { $exists: false } }],
    },
    { activeJobId: job._id },
    { returnDocument: 'after' },
  );

  if (!claimed) {
    // Another job won the slot. Delete the orphan we just created so it
    // doesn't linger as pending forever (the startup reaper would eventually
    // catch it anyway, but cleaning up immediately is cheap and correct).
    await JobModel.deleteOne({ _id: job._id }).catch(bgError('jobRunner.orphanDelete'));
    throw new Error('A job is already running for this course. Please wait for it to complete.');
  }

  jobEvents.emit('started', {
    jobId: job._id.toString(),
    courseId: params.courseId,
    type: params.type,
    userId: params.userId,
  });

  jobLimit(() => processJob(job._id.toString())).catch((err) => {
    console.error('[JobRunner] Unhandled error in processJob:'.red, err);
  });

  return job._id.toString();
};

// ── Execute (core job logic) ──────────────────────────────

const executeJob = async ({ courseId, type, metadata }: { courseId: string; type: string; metadata?: Record<string, unknown> | null }): Promise<void> => {
  const course = await CourseModel.findById(courseId);
  if (!course) throw new Error('Course not found');

  switch (type) {
    case 'clarify': {
      const result = await clarifyCourse({ goal: course.goal });
      await CourseModel.findByIdAndUpdate(courseId, {
        clarifyData: result,
        ...(result.courseName && {
          name: result.courseName,
          slug: await generateUniqueSlug({ userId: course.userId.toString(), name: result.courseName }),
        }),
        // Clear all downstream data — answers may no longer match new questions
        depthPreviews: null,
        depth: null,
        structure: null,
        feedbackHistory: [],
      });
      await cleanupCourseContent(courseId);
      return;
    }
    case 'generate_structure': {
      await cleanupCourseContent(courseId);
      const result = await generateCourseStructure({
        goal: course.goal,
        answers: formatCourseAnswers(course),
        depth: course.depth as CourseDepth,
      });
      await CourseModel.findByIdAndUpdate(courseId, {
        name: result.courseName,
        slug: await generateUniqueSlug({ userId: course.userId.toString(), name: result.courseName }),
        domain: result.domain,
        structure: { reasoning: result.reasoning, modules: result.modules },
        feedbackHistory: [],
      });
      return;
    }
    case 'refine_structure': {
      await cleanupCourseContent(courseId);
      const feedback = course.pendingFeedback ?? '';
      const result = await refineCourseStructure({
        goal: course.goal,
        answers: formatCourseAnswers(course),
        depth: (course.depth as CourseDepth) ?? 'comprehensive',
        currentStructure: course.structure as {
          modules: { name: string; description: string; lessons: { name: string; description: string }[] }[];
        },
        currentDomain: course.domain ?? null,
        feedback,
        feedbackHistory: course.feedbackHistory,
      });
      await CourseModel.findByIdAndUpdate(courseId, {
        name: result.courseName,
        slug: await generateUniqueSlug({ userId: course.userId.toString(), name: result.courseName }),
        domain: result.domain,
        structure: { reasoning: result.reasoning, modules: result.modules },
        feedbackHistory: [...course.feedbackHistory, feedback],
        pendingFeedback: null,
      });
      return;
    }
    case 'generate_lesson': {
      const moduleIndex = (metadata?.moduleIndex as number) ?? 0;
      const lessonIndex = (metadata?.lessonIndex as number) ?? 0;
      const mod = course.structure?.modules?.[moduleIndex];
      const lesson = mod?.lessons?.[lessonIndex];
      if (!mod || !lesson) throw new Error(`Lesson not found: module ${moduleIndex}, lesson ${lessonIndex}`);

      console.log(`[JobRunner] generate_lesson — courseId: ${courseId}, module: ${moduleIndex}, lesson: ${lessonIndex}`.cyan);

      // Wrap the generation body in a timer + outcome classifier so
      // /metrics exposes average lesson-gen latency and the distribution
      // of success / persistence-gate-fail / error terminations. Timeouts
      // are handled by the Promise.race one level up and don't land here.
      const lessonGenStart = Date.now();
      let lessonGenOutcome: LessonGenerationOutcome = 'success';
      try {
      // Use the same LangGraph agent as the SSE streaming path (no-op writer for background jobs)
      const agentResult = await lessonGenerationAgent.invoke(
        {
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
          includeImage: (metadata?.includeImage as boolean) ?? true,
          includeLinks: (metadata?.includeLinks as boolean) ?? true,
        },
        { configurable: { writer: () => {} } },
      );

      if (!(await CourseModel.exists({ _id: courseId }))) {
        console.log(`[JobRunner] Course ${courseId} deleted mid-generation; discarding lesson ${moduleIndex}/${lessonIndex} output`.yellow);
        return;
      }

      // Persistence gate: refuse to write lesson content that fails a minimal
      // structural contract (has intro+summary+≥2 sections, summary is 60–800
      // chars). The `contentOutputSchema` on the agent already enforces summary
      // length, but the block-structure check catches cases where repair loops
      // exit early with a broken structure. Throwing here lets the existing
      // job-failure path surface the issue rather than silently shipping a
      // garbage lesson to the learner.
      const persistableReasons: string[] = [];
      const summaryText = (agentResult.contentSummary ?? '').trim();
      if (summaryText.length < 60) persistableReasons.push(`summary too short (${summaryText.length} chars)`);
      if (summaryText.length > 800) persistableReasons.push(`summary too long (${summaryText.length} chars)`);
      const introCount = agentResult.contentBlocks.filter((b) => b.type === 'intro').length;
      const summaryBlockCount = agentResult.contentBlocks.filter((b) => b.type === 'summary').length;
      const sectionCount = agentResult.contentBlocks.filter((b) => b.type === 'section').length;
      if (introCount === 0) persistableReasons.push('missing intro block');
      if (summaryBlockCount === 0) persistableReasons.push('missing summary block');
      if (sectionCount < 2) persistableReasons.push(`only ${sectionCount} section block(s), need ≥2`);
      if (persistableReasons.length > 0) {
        throw new Error(
          `[JobRunner] Lesson ${courseId}/${moduleIndex}/${lessonIndex} failed persistence validation: ${persistableReasons.join('; ')}`,
        );
      }

      // Upsert — handles both first generation and regeneration.
      // `completed: true` matches what the SSE streaming path sets in
      // streamLessonContent.ts so the startup reaper in conf/mongo.ts
      // doesn't sweep these lessons on the next API restart.
      const existing = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });
      await LessonContentModel.findOneAndUpdate(
        { courseId, moduleIndex, lessonIndex },
        {
          courseId,
          moduleIndex,
          lessonIndex,
          blocks: agentResult.contentBlocks,
          summary: agentResult.contentSummary,
          heroImageUrl: agentResult.heroImageUrl,
          completed: true,
          version: existing ? existing.version + 1 : 1,
        },
        { upsert: true, returnDocument: 'after' },
      );

      // Persist the insights the agent extracted. The SSE streaming path
      // does this at streamLessonContent.ts; the job path previously dropped
      // the `agentResult.insights` field on the floor, which left every
      // orchestrator-generated lesson with zero spaced-repetition cards and
      // an empty insight queue at Step 13. Best-effort: insights are
      // additive enrichment — failure here must not fail the job.
      if (agentResult.insights && agentResult.insights.length > 0) {
        await persistLessonInsights({
          courseId,
          moduleIndex,
          lessonIndex,
          insights: agentResult.insights,
        }).catch(bgError('jobRunner.persistLessonInsights'));
      }
      return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lessonGenOutcome = msg.includes('failed persistence validation')
          ? 'persistence_gate_fail'
          : 'error';
        throw e;
      } finally {
        recordLessonGenerationDuration(Date.now() - lessonGenStart);
        bumpLessonGenerationOutcome(lessonGenOutcome);
      }
    }
    case 'generate_depth_previews': {
      // Clear downstream data — depth selection and structure are now stale
      await CourseModel.findByIdAndUpdate(courseId, {
        depthPreviews: null,
        structure: null,
        feedbackHistory: [],
      });
      await cleanupCourseContent(courseId);
      const result = await generateDepthPreviews({
        goal: course.goal,
        answers: formatCourseAnswers(course),
      });
      await CourseModel.findByIdAndUpdate(courseId, { depthPreviews: result });
      return;
    }
    case 'generate_module_quiz': {
      const moduleIndex = (metadata?.moduleIndex as number) ?? 0;
      const mod = course.structure?.modules?.[moduleIndex];
      if (!mod) throw new Error(`Module not found: ${moduleIndex}`);

      const lessonCount = mod.lessons?.length ?? 0;
      const generatedCount = await LessonContentModel.countDocuments({ courseId, moduleIndex });
      if (generatedCount < lessonCount) {
        throw new Error(`Not all lessons generated for module ${moduleIndex} (${generatedCount}/${lessonCount})`);
      }

      console.log(`[JobRunner] generate_module_quiz — courseId: ${courseId}, module: ${moduleIndex}`.cyan);

      const agentResult = await quizGenerationAgent.invoke({
        courseId,
        goal: course.goal,
        answers: formatCourseAnswers(course),
        depth: course.depth ?? 'comprehensive',
        domain: course.domain ?? null,
        structure: course.structure as {
          modules: { name: string; description: string; lessons: { name: string; description: string }[] }[];
        },
        moduleIndex,
      });

      if (!(await CourseModel.exists({ _id: courseId }))) {
        console.log(`[JobRunner] Course ${courseId} deleted mid-generation; discarding quiz output for module ${moduleIndex}`.yellow);
        return;
      }

      const existing = await ModuleQuizContentModel.findOne({ courseId, moduleIndex });
      await ModuleQuizContentModel.findOneAndUpdate(
        { courseId, moduleIndex },
        {
          courseId,
          moduleIndex,
          questions: agentResult.questions,
          version: existing ? existing.version + 1 : 1,
        },
        { upsert: true },
      );
      return;
    }
    default:
      throw new Error(`Unknown job type: ${type}`);
  }
};

// ── Process ────────────────────────────────────────────────

const processJob = async (jobId: string): Promise<void> => {
  const job = await JobModel.findById(jobId);
  if (!job) return;

  await JobModel.findByIdAndUpdate(jobId, { status: 'processing' });

  let status: 'completed' | 'failed' = 'failed';
  let errorMessage: string | undefined;

  try {
    await Promise.race([
      executeJob({ courseId: job.courseId.toString(), type: job.type, metadata: job.metadata }),
      jobTimeout({ ms: JOB_TIMEOUT_MS, jobId }),
    ]);
    status = 'completed';
  } catch (error: unknown) {
    errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[JobRunner] Job ${jobId} failed: ${errorMessage}`.red);
  } finally {
    // Use findByIdAndUpdate so this is a no-op if the job document was deleted (e.g. course/account deletion)
    await JobModel.findByIdAndUpdate(jobId, {
      status,
      completedAt: new Date(),
      ...(status === 'failed' ? { error: errorMessage } : {}),
    });

    // Always clear activeJobId before emitting WS event so client refetch sees the updated state
    await CourseModel.findOneAndUpdate(
      { _id: job.courseId, activeJobId: job._id },
      { activeJobId: null },
    );

    if (status === 'completed') {
      const completedPayload = { jobId, status: 'completed' as const, courseId: job.courseId.toString(), type: job.type, userId: job.userId.toString() };
      jobEvents.emit(`job:${jobId}`, completedPayload);
      jobEvents.emit('update', completedPayload);
    } else {
      const failedPayload = { jobId, status: 'failed' as const, error: errorMessage, courseId: job.courseId.toString(), type: job.type, userId: job.userId.toString() };
      jobEvents.emit(`job:${jobId}`, failedPayload);
      jobEvents.emit('update', failedPayload);
    }
  }
};
