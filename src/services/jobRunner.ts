/**
 * NOTE — split lines for the next maintainer.
 *
 * This file is ~780 LOC and mixes the job lifecycle (submit / process /
 * complete / fail) with type-specific logic (a 9-branch switch over
 * `executeJob`). The next change here should extract along this seam:
 *
 *   - This file (kept) — `submitJob`, `processJob`, the pLimit
 *     concurrency cap, the `activeJobId` mutex, status transitions.
 *   - `jobTypes/` directory — one file per job type:
 *       `clarifyJob.ts`
 *       `generateStructureJob.ts`
 *       `refineStructureJob.ts`
 *       `generateDepthPreviewsJob.ts`
 *       `generateLessonJob.ts`
 *       `regenerateHeroJob.ts`
 *       `regenerateLinksJob.ts`
 *       `generateModuleQuizJob.ts`
 *       `lessonNarrationJob.ts`
 *
 * Each file exports `executeXxxJob({ jobId, userId, courseId, metadata, course })`
 * and `executeJob` becomes a thin dispatch table. The shared course
 * fetch + `cleanupCourseContent` calls stay in the dispatcher.
 *
 * Add bounds-checking on `metadata.moduleIndex` / `metadata.lessonIndex`
 * to the dispatcher (audit P2 finding: client-supplied indices are
 * currently used directly as array accessors with no validation).
 */
import mongoose from 'mongoose';
import pLimit from 'p-limit';
import * as Sentry from '@sentry/node';
import JobModel from '@models/JobModel';
import CourseModel, { ICourse } from '@models/CourseModel';
import LessonContentModel, { ILessonBlock } from '@models/LessonContentModel';
import InsightModel from '@models/InsightModel';
import { JobType, CourseDepth } from '@lib/constants';
import { lessonGenerationAgent } from '@lib/ai/agents/lessonGeneration';
import { contextLoad, imageGeneration, linksGeneration } from '@lib/ai/agents/lessonGeneration/nodes';
import type { LessonState } from '@lib/ai/agents/lessonGeneration/state';
import { quizGenerationAgent } from '@lib/ai/agents/quizGeneration';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import { clarifyCourse, classifyGoalType, generateCourseStructure, refineCourseStructure, generateDepthPreviews, isThinFreeText } from './courseService';
import { cleanupCourseContent } from './courseCleanupService';
import { GeneratedInsight, persistLessonInsights } from './insightContentService';
import { deleteByPrefix } from './s3Service';
import { jobEvents } from './jobEvents';
import type { LessonProgressEvent } from '@src/types/socketEvents';
import { bgError } from '@lib/bg';
import { InsufficientCreditsError, MaxConcurrentJobsError, debitActualSpend, getBalance } from './creditService';
import UserModel from '@models/UserModel';
import { PLANS, PlanKey } from '@lib/creditPricing';
import { monetizationLog, jobLog } from '@lib/loggers';
import {
  bumpLessonGenerationOutcome,
  bumpStructureThinFreeTextInput,
  recordLessonGenerationDuration,
  type LessonGenerationOutcome,
} from '@lib/metrics';
import { generateUniqueSlug } from '@lib/slugify';
import { runWithUsageContext } from '@lib/usageContext';
import { runLessonNarration } from './lessonNarrationService';
import { indexLessonContent } from './lessonRagService';
import { generateMentorPrompts } from '@lib/ai/agents/lessonMentor/promptsGenerator';
import { regenerateAndPersistDesignPrompts } from '@lib/ai/agents/courseDesign/promptsGenerator';

// ── Concurrency & timeout ───────────────────────────────


const MAX_JOB_CONCURRENCY = 50;
const JOB_TIMEOUT_MS = 600_000; // 10 minutes

export const jobLimit = pLimit(MAX_JOB_CONCURRENCY);

const jobTimeout = ({ ms, jobId }: { ms: number; jobId: string }) =>
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Job ${jobId} timed out after ${ms / 1000}s`)), ms),
  );

// ── Helpers ─────────────────────────────────────────────

// Accepts the plain `ICourse` shape rather than the full `CourseDocument`
// (Mongoose-hydrated doc) so callers can pass `.lean()`-fetched courses.
// Only reads `course.answers` and `course.clarifyData.questions` — both
// pure data, no Mongoose methods needed.
const formatCourseAnswers = (course: Pick<ICourse, 'answers' | 'clarifyData'>): { questionId: string; answer: string }[] => {
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
  // Pre-generate the Job id so the credit ledger row and Job doc share it —
  // otherwise the ledger would need a follow-up update to backfill the id
  // after Job creation.
  const jobId = new mongoose.Types.ObjectId();

  // Create the Job document first, then atomically claim the course slot with
  // the real job id. The previous pattern wrote a placeholder ObjectId to
  // `course.activeJobId` and then overwrote it — which meant (a) clients that
  // polled /job/:jobId during the placeholder window got a 404, and (b) if
  // JobModel.create() threw after the guard, the placeholder was never
  // cleared and the course stayed permanently locked.
  const job = await JobModel.create({
    _id: jobId,
    userId: params.userId,
    courseId: params.courseId,
    type: params.type,
    status: 'pending',
    ...(params.metadata && { metadata: params.metadata }),
  });

  // Pre-flight gates: credit balance + per-user concurrent-job cap. Credit
  // gate is "balance ≥ 1 credit"; real cost is debited on job success by
  // `debitActualSpend` (reads the spend accumulator built up by `recordUsage`
  // during the job). No reservation, no pre-debit — if the job fails, the
  // user isn't charged, and we eat the provider cost we incurred along the
  // way.
  //
  // The concurrency gate reads the plan's `maxConcurrentJobs` and counts the
  // user's currently-active Job rows (pending + running, excluding the row
  // we just inserted). A single user with 1 credit used to be able to hog
  // all 50 slots of the global `p-limit`; this gates them to their plan.
  //
  // The Job doc is deleted if either gate rejects, keeping the "submitJob
  // throws → no orphan job row" invariant intact.
  try {
    const balance = await getBalance(params.userId);
    if (balance.total < 1) {
      monetizationLog.info(
        `Job rejected (credits): user=${params.userId} type=${params.type} balance=${balance.total}`,
      );
      throw new InsufficientCreditsError({ need: 1, have: balance.total });
    }

    const user = await UserModel.findById(params.userId).select('subscription.plan').lean();
    const planKey: PlanKey = (user?.subscription?.plan as PlanKey | undefined) ?? 'free';
    const limit = PLANS[planKey].maxConcurrentJobs;
    // Exclude the row we just inserted; count the rest. `pending` is the
    // initial state and `processing` is the worker-owned state before
    // completed/failed.
    const active = await JobModel.countDocuments({
      _id: { $ne: jobId },
      userId: params.userId,
      status: { $in: ['pending', 'processing'] },
    });
    if (active >= limit) {
      monetizationLog.info(
        `Job rejected (concurrency): user=${params.userId} plan=${planKey} active=${active}/${limit} type=${params.type}`,
      );
      throw new MaxConcurrentJobsError({ active, limit });
    }
  } catch (err) {
    await JobModel.deleteOne({ _id: jobId }).catch(bgError('jobRunner.gateRollback'));
    throw err;
  }

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

  // Thread lesson coords through the started event so the client can
  // stamp `course.activeLesson` optimistically on the same frame the
  // job submits. Without this the sidebar / overview indicators don't
  // flip to 'generating' until the next /course refetch or the first
  // job:progress event arrives.
  const metadataForEvent = (params.metadata ?? {}) as { moduleIndex?: number; lessonIndex?: number };
  jobEvents.emit('started', {
    jobId: job._id.toString(),
    courseId: params.courseId,
    type: params.type,
    userId: params.userId,
    ...(typeof metadataForEvent.moduleIndex === 'number' ? { moduleIndex: metadataForEvent.moduleIndex } : {}),
    ...(typeof metadataForEvent.lessonIndex === 'number' ? { lessonIndex: metadataForEvent.lessonIndex } : {}),
  });

  jobLog.info(
    `${params.type}:claim jobId=${job._id.toString()} userId=${params.userId} courseId=${params.courseId} active=${jobLimit.activeCount}/${MAX_JOB_CONCURRENCY} pending=${jobLimit.pendingCount}`,
  );

  jobLimit(() => processJob(job._id.toString())).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    jobLog.error(`processJob:unhandled jobId=${job._id.toString()} msg=${msg}`);
    Sentry.captureException(err, { tags: { source: 'jobRunner.processJob.unhandled' } });
  });

  return job._id.toString();
};

// ── Execute (core job logic) ──────────────────────────────

const executeJob = async ({ jobId, userId, courseId, type, metadata }: { jobId: string; userId: string; courseId: string; type: string; metadata?: Record<string, unknown> | null }): Promise<void> => {
  // Read-only — every downstream mutation goes through `findByIdAndUpdate`
  // by id, never via `course.save()`. `.lean()` cuts hydration overhead on
  // a doc that can be very large (full structure with hundreds of lessons)
  // and matters under the 50-job concurrency cap. If a future change ever
  // needs to call a Mongoose method on this object, drop the `.lean()`.
  const course = await CourseModel.findById(courseId).lean();
  if (!course) throw new Error('Course not found');

  switch (type) {
    case 'clarify': {
      // Skip the classifier when the user already confirmed the goalType via
      // the ClarifyStep chip (`goalTypeConfidence === 'high'`). On any other
      // entry — fresh course, goal-text change cascade, or pre-feature
      // course — re-classify. The cleared-on-goal-change rule is enforced
      // in updateCourseController.
      const skipClassification = course.goalType !== null && course.goalTypeConfidence === 'high';
      const classification = skipClassification
        ? { goalType: course.goalType!, confidence: 'high' as const, noun: course.clarifyData?.goalTypeNoun ?? course.goal.slice(0, 60) }
        : await classifyGoalType({ goal: course.goal });

      const result = await clarifyCourse({ goal: course.goal, goalType: classification.goalType });

      await CourseModel.findByIdAndUpdate(courseId, {
        clarifyData: { ...result, goalTypeNoun: classification.noun },
        goalType: classification.goalType,
        goalTypeConfidence: classification.confidence,
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
        goalType: course.goalType ?? 'master',
      });
      await CourseModel.findByIdAndUpdate(courseId, {
        name: result.courseName,
        slug: await generateUniqueSlug({ userId: course.userId.toString(), name: result.courseName }),
        domain: result.domain,
        structure: { reasoning: result.reasoning, modules: result.modules },
        feedbackHistory: [],
      });
      // Generate the design-chat opening prompts AFTER the structure is
      // persisted, since the helper reads the current course state.
      // Awaited (not fire-and-forget) so the prompts are ready by the
      // time the client receives the job-completion socket event and
      // transitions to the structure-review screen — but errors are
      // swallowed inside the helper, so a Haiku failure never fails the
      // structure job. ~1-2s added to a 30s+ job is negligible.
      await regenerateAndPersistDesignPrompts(courseId);
      return;
    }
    case 'refine_structure': {
      await cleanupCourseContent(courseId);
      const feedback = course.pendingFeedback ?? '';
      const result = await refineCourseStructure({
        goal: course.goal,
        answers: formatCourseAnswers(course),
        depth: (course.depth as CourseDepth) ?? 'comprehensive',
        goalType: course.goalType ?? 'master',
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
      // Re-generate design-chat prompts because the structure changed.
      // Same fire-after-persist + swallow-errors pattern as generate_structure.
      await regenerateAndPersistDesignPrompts(courseId);
      return;
    }
    case 'generate_lesson': {
      const moduleIndex = (metadata?.moduleIndex as number) ?? 0;
      const lessonIndex = (metadata?.lessonIndex as number) ?? 0;
      const includeImage = (metadata?.includeImage as boolean) ?? true;
      const includeLinks = (metadata?.includeLinks as boolean) ?? true;
      const mod = course.structure?.modules?.[moduleIndex];
      const lesson = mod?.lessons?.[lessonIndex];
      if (!mod || !lesson) throw new Error(`Lesson not found: module ${moduleIndex}, lesson ${lessonIndex}`);

      jobLog.info(
        `generate_lesson:start jobId=${jobId} userId=${userId} course=${courseId} module=${moduleIndex} lesson=${lessonIndex} hero=${includeImage} links=${includeLinks}`,
      );

      const lessonGenStart = Date.now();
      let lessonGenOutcome: LessonGenerationOutcome = 'success';

      // Per-job buffers. The writer tees agent events into three places:
      //   1. `allBlocks` + debounced LessonContent upsert — lets a reloaded
      //      client rehydrate partial content straight from Mongo while the
      //      job continues in the background. Replaces the SSE path's
      //      per-request accumulator.
      //   2. `jobEvents.emit('progress', ...)` — the live-stream channel the
      //      client subscribes to via Socket.io. Zero client-server round
      //      trips per block, unlike the 3 s LessonContent poll.
      //   3. State captured here (summary, heroImageUrl, pendingInsights) for
      //      the final persistence gate + insight persistence after the
      //      agent stream completes.
      const allBlocks: ILessonBlock[] = [];
      let savedHeroImageUrl: string | null = null;
      let pendingInsights: GeneratedInsight[] = [];

      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      let savePromise: Promise<void> = Promise.resolve();
      const saveToDb = async ({ summary }: { summary: string | null }) => {
        await LessonContentModel.findOneAndUpdate(
          { courseId, moduleIndex, lessonIndex },
          {
            courseId,
            moduleIndex,
            lessonIndex,
            blocks: allBlocks,
            summary,
            heroImageUrl: savedHeroImageUrl,
            includeHeroImage: includeImage,
          },
          { upsert: true, returnDocument: 'after' },
        );
      };
      const debouncedSave = ({ summary }: { summary: string | null }) => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          savePromise = saveToDb({ summary }).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            jobLog.error(`generate_lesson:save-fail jobId=${jobId} course=${courseId} module=${moduleIndex} lesson=${lessonIndex} msg=${msg}`);
          });
        }, 500);
      };

      const emitProgress = (event: LessonProgressEvent) => {
        jobEvents.emit('progress', {
          jobId,
          userId,
          courseId,
          type: 'generate_lesson',
          moduleIndex,
          lessonIndex,
          event,
        });
      };

      // Writer passed into the LangGraph agent. Fan-out: progress event (live
      // socket) + DB save (reload hydration). The agent itself is unchanged —
      // same shape as the old SSE writer, and the agent's nodes (which were
      // already wired for the SSE path via `config.configurable.writer`)
      // continue to work unmodified.
      const trackingWriter = (event: LessonProgressEvent) => {
        emitProgress(event);
        if (event.type === 'block') {
          allBlocks.push(event.block);
          debouncedSave({ summary: null });
        } else if (event.type === 'hero_image') {
          savedHeroImageUrl = event.s3Key ?? event.url;
          debouncedSave({ summary: null });
        }
      };

      try {
        // Stream mode instead of `.invoke()` so we can inspect per-node
        // chunks — specifically, the contentValidation completion, which
        // lets us emit a `content_ready` event with the placeholder hints
        // the client needs to render quiz/exercise skeletons while the
        // interactiveGeneration node is still running. The SSE path at
        // streamLessonContent.ts derived the same event from the same
        // chunk shape; we're just moving the logic into the job body.
        let capturedSummary = '';
        for await (const chunk of await lessonGenerationAgent.stream(
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
            includeImage,
            includeLinks,
          },
          {
            streamMode: 'updates',
            configurable: { writer: trackingWriter },
          },
        )) {
          if (chunk.contentGeneration) {
            const { contentSummary } = chunk.contentGeneration as { contentSummary?: string };
            if (contentSummary) capturedSummary = contentSummary;
          }
          if (chunk.insightGeneration) {
            const { insights } = chunk.insightGeneration as { insights?: GeneratedInsight[] };
            if (insights) pendingInsights = insights;
          }
          if (chunk.contentValidation) {
            // Derive placeholder hints deterministically from the blocks the
            // agent has emitted so far. Quiz placeholders land after the last
            // two sections; exercise placeholder lands just before the
            // summary. Same logic as streamLessonContent.ts used to run.
            const sections = allBlocks.filter((b) => b.type === 'section');
            const summaryBlock = allBlocks.find((b) => b.type === 'summary');
            const maxOrder = allBlocks.length > 0 ? Math.max(...allBlocks.map((b) => b.order)) : 0;
            const quizSections = sections.slice(-2);
            const quizPlaceholders = quizSections.map((s, i) => ({
              type: 'quiz' as const,
              order: s.order + 0.5,
              id: `placeholder-quiz-${i}`,
            }));
            const exerciseOrder = summaryBlock ? summaryBlock.order - 0.5 : maxOrder + 1;
            const exercisePlaceholder = { type: 'exercise' as const, order: exerciseOrder, id: 'placeholder-exercise' };
            emitProgress({
              type: 'content_ready',
              placeholders: [...quizPlaceholders, exercisePlaceholder],
            });
          }
        }

        if (!(await CourseModel.exists({ _id: courseId }))) {
          jobLog.warn(
            `generate_lesson:abandon jobId=${jobId} course=${courseId} module=${moduleIndex} lesson=${lessonIndex} reason=course_deleted_midflight`,
          );
          if (saveTimer) clearTimeout(saveTimer);
          return;
        }

        // Flush any pending debounced save before the final persistence step.
        if (saveTimer) clearTimeout(saveTimer);
        await savePromise;

        // Persistence gate — same contract as the old SSE path.
        const persistableReasons: string[] = [];
        const summaryText = capturedSummary.trim();
        if (summaryText.length < 60) persistableReasons.push(`summary too short (${summaryText.length} chars)`);
        if (summaryText.length > 800) persistableReasons.push(`summary too long (${summaryText.length} chars)`);
        const introCount = allBlocks.filter((b) => b.type === 'intro').length;
        const summaryBlockCount = allBlocks.filter((b) => b.type === 'summary').length;
        const sectionCount = allBlocks.filter((b) => b.type === 'section').length;
        if (introCount === 0) persistableReasons.push('missing intro block');
        if (summaryBlockCount === 0) persistableReasons.push('missing summary block');
        if (sectionCount < 2) persistableReasons.push(`only ${sectionCount} section block(s), need ≥2`);
        if (persistableReasons.length > 0) {
          throw new Error(
            `[JobRunner] Lesson ${courseId}/${moduleIndex}/${lessonIndex} failed persistence validation: ${persistableReasons.join('; ')}`,
          );
        }

        const existing = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });
        await LessonContentModel.findOneAndUpdate(
          { courseId, moduleIndex, lessonIndex },
          {
            courseId,
            moduleIndex,
            lessonIndex,
            blocks: allBlocks,
            summary: capturedSummary,
            heroImageUrl: savedHeroImageUrl,
            includeHeroImage: includeImage,
            completed: true,
            version: existing ? existing.version + 1 : 1,
          },
          { upsert: true, returnDocument: 'after' },
        );

        if (pendingInsights.length > 0) {
          const persistedIds = await persistLessonInsights({
            courseId,
            moduleIndex,
            lessonIndex,
            insights: pendingInsights,
          }).catch((e) => {
            bgError('jobRunner.persistLessonInsights')(e);
            return [] as string[];
          });
          emitProgress({ type: 'insights_saved', count: persistedIds.length });
        }

        // Index the freshly-saved lesson into the RAG store. Awaited (not
        // fire-and-forget) so the embedding cost is recorded inside the
        // job's usage context — `recordUsage` reads the active ALS scope,
        // and a detached promise can fire after the scope has exited.
        // No-ops gracefully when OPENAI/PINECONE keys aren't configured.
        await indexLessonContent({
          courseId,
          moduleIndex,
          lessonIndex,
          blocks: allBlocks,
        }).catch(bgError('jobRunner.indexLessonContent'));

        // Generate lesson-specific opening prompts for the mentor panel.
        // Awaited so the Haiku call is recorded in the job's spend
        // accumulator. Failures (timeouts, malformed JSON) leave the
        // field empty — the chat history endpoint falls back to the
        // hard-coded generic prompts in that case. Re-runs of this
        // job overwrite the field, keeping prompts fresh after lesson
        // regeneration.
        const lessonContentForPrompts = allBlocks
          .filter((b) => ['intro', 'section', 'callout', 'summary'].includes(b.type))
          .sort((a, b) => a.order - b.order)
          .map((b) => b.content)
          .join('\n\n');
        const generatedPrompts = await generateMentorPrompts({
          courseGoal: course.goal ?? '',
          moduleTitle: mod.name,
          lessonTitle: lesson.name,
          lessonSummary: capturedSummary,
          lessonContent: lessonContentForPrompts,
        }).catch((e) => {
          bgError('jobRunner.generateMentorPrompts')(e);
          return null;
        });
        if (generatedPrompts && generatedPrompts.length > 0) {
          await LessonContentModel.updateOne(
            { courseId, moduleIndex, lessonIndex },
            { $set: { suggestedMentorPrompts: generatedPrompts } },
          ).catch(bgError('jobRunner.saveMentorPrompts'));
        }
        return;
      } catch (e) {
        if (saveTimer) clearTimeout(saveTimer);
        // Clean up partial content so the reloaded client (which would
        // otherwise see `completed: false` rows with the debounced writes)
        // gets a clean slate on retry. Matches the cleanup path the SSE
        // endpoint used to run on abort/failure.
        //
        // All three cleanups must complete before we re-throw — previously
        // only the first was awaited, leaving deleteMany + S3 racing
        // against the job's failure bookkeeping. allSettled so a slow S3
        // call doesn't block the others, and a single failure doesn't
        // abandon the rest.
        await Promise.allSettled([
          LessonContentModel.deleteOne({ courseId, moduleIndex, lessonIndex, completed: false }).catch(
            bgError('jobRunner.cleanupLesson'),
          ),
          InsightModel.deleteMany({ courseId, moduleIndex, lessonIndex }).catch(
            bgError('jobRunner.cleanupInsights'),
          ),
          deleteByPrefix(`lessons/${courseId}/${moduleIndex}/${lessonIndex}/`).catch(
            bgError('jobRunner.cleanupS3'),
          ),
        ]);

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

      jobLog.info(
        `generate_module_quiz:start jobId=${jobId} userId=${userId} course=${courseId} module=${moduleIndex} lessons=${lessonCount}`,
      );

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
        jobLog.warn(
          `generate_module_quiz:abandon jobId=${jobId} course=${courseId} module=${moduleIndex} reason=course_deleted_midflight`,
        );
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
    case 'regenerate_hero': {
      const moduleIndex = (metadata?.moduleIndex as number) ?? 0;
      const lessonIndex = (metadata?.lessonIndex as number) ?? 0;
      const lessonContent = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });
      if (!lessonContent) throw new Error(`Lesson content missing: ${moduleIndex}/${lessonIndex}`);

      const emitProgress = (event: LessonProgressEvent) => {
        jobEvents.emit('progress', { jobId, userId, courseId, type: 'regenerate_hero', moduleIndex, lessonIndex, event });
      };

      const baseState = {
        courseId,
        goal: course.goal,
        answers: formatCourseAnswers(course),
        depth: course.depth ?? 'comprehensive',
        domain: course.domain ?? null,
        structure: course.structure as LessonState['structure'],
        moduleIndex,
        lessonIndex,
        includeImage: true,
        includeLinks: false,
      };
      const derived = await contextLoad(baseState as unknown as LessonState);
      const state = { ...baseState, ...derived } as LessonState;

      const result = await imageGeneration(state, { configurable: { writer: emitProgress } });
      const s3Key = result.heroImageUrl ?? null;

      if (!(await CourseModel.exists({ _id: courseId }))) return;
      await LessonContentModel.updateOne(
        { courseId, moduleIndex, lessonIndex },
        { heroImageUrl: s3Key, includeHeroImage: true },
      );
      return;
    }
    case 'regenerate_links': {
      const moduleIndex = (metadata?.moduleIndex as number) ?? 0;
      const lessonIndex = (metadata?.lessonIndex as number) ?? 0;
      const lessonContent = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });
      if (!lessonContent) throw new Error(`Lesson content missing: ${moduleIndex}/${lessonIndex}`);

      const emitProgress = (event: LessonProgressEvent) => {
        jobEvents.emit('progress', { jobId, userId, courseId, type: 'regenerate_links', moduleIndex, lessonIndex, event });
      };

      const baseState = {
        courseId,
        goal: course.goal,
        answers: formatCourseAnswers(course),
        depth: course.depth ?? 'comprehensive',
        domain: course.domain ?? null,
        structure: course.structure as LessonState['structure'],
        moduleIndex,
        lessonIndex,
        includeImage: false,
        includeLinks: true,
        contentSummary: lessonContent.summary ?? '',
      };
      const derived = await contextLoad(baseState as unknown as LessonState);
      const state = { ...baseState, ...derived } as LessonState;

      const result = await linksGeneration(state, { configurable: { writer: emitProgress } });
      const linksBlock = result.linksBlock ?? null;
      if (!linksBlock) return;

      if (!(await CourseModel.exists({ _id: courseId }))) return;
      const blocks = [...lessonContent.blocks];
      const existingIdx = blocks.findIndex((b) => b.type === 'links');
      if (existingIdx >= 0) {
        blocks[existingIdx] = linksBlock;
      } else {
        blocks.push(linksBlock);
      }
      await LessonContentModel.updateOne(
        { courseId, moduleIndex, lessonIndex },
        { blocks },
      );
      return;
    }
    case 'lesson_narration': {
      const moduleIndex = (metadata?.moduleIndex as number) ?? 0;
      const lessonIndex = (metadata?.lessonIndex as number) ?? 0;
      const voiceId = (metadata?.voiceId as string | undefined) ?? null;
      const rate = (metadata?.rate as number | undefined) ?? null;

      const emitProgress = (event: LessonProgressEvent) => {
        jobEvents.emit('progress', {
          jobId, userId, courseId, type: 'lesson_narration', moduleIndex, lessonIndex, event,
        });
      };
      emitProgress({ type: 'narration_started' });

      const result = await runLessonNarration({
        courseId, moduleIndex, lessonIndex, voiceId, rate,
      });

      emitProgress({
        type: 'narration_ready',
        cached: result.cached,
        voiceId: result.voiceId,
      });
      return;
    }
    default:
      throw new Error(`Unknown job type: ${type}`);
  }
};

// ── Process ────────────────────────────────────────────────

const processJob = async (jobId: string): Promise<void> => {
  const job = await JobModel.findById(jobId);
  if (!job) {
    jobLog.warn(`processJob:vanished jobId=${jobId} — job document missing at dequeue`);
    return;
  }

  await JobModel.findByIdAndUpdate(jobId, { status: 'processing' });
  const startedAt = Date.now();
  jobLog.info(
    `${job.type}:run jobId=${jobId} userId=${job.userId.toString()} course=${job.courseId.toString()}`,
  );

  let status: 'completed' | 'failed' = 'failed';
  let errorMessage: string | undefined;

  const jobMetadata = (job.metadata ?? {}) as Record<string, unknown>;
  // Snapshot the user's plan + subscription status at job-start so every
  // recordUsage call under the scope stamps these onto the persisted row.
  // Single projection — cheap; failures fall through to a stamp-less scope
  // (events still record, just with no plan info).
  const planSnapshot = await UserModel.findById(job.userId, { 'subscription.plan': 1, 'subscription.status': 1 })
    .lean()
    .catch((e) => {
      bgError('jobRunner.planSnapshot')(e);
      return null;
    });
  // Enter a usage-tracking scope so every paid action the agents trigger
  // (LLMs, image gen, Tavily, Jina) is attributed to this user + job.
  // Module/lesson indices are threaded where present so a single
  // lesson-generation job's rows are filterable by lesson coordinate.
  const runInUsageContext = <T,>(fn: () => Promise<T>): Promise<T> =>
    runWithUsageContext({
      ctx: {
        userId: job.userId.toString(),
        source: 'job',
        jobId,
        courseId: job.courseId.toString(),
        ...(typeof jobMetadata.moduleIndex === 'number' ? { moduleIndex: jobMetadata.moduleIndex } : {}),
        ...(typeof jobMetadata.lessonIndex === 'number' ? { lessonIndex: jobMetadata.lessonIndex } : {}),
        ...(planSnapshot?.subscription?.plan ? { plan: planSnapshot.subscription.plan } : {}),
        ...(planSnapshot?.subscription?.status ? { subscriptionStatus: planSnapshot.subscription.status } : {}),
      },
      fn,
    }) as Promise<T>;

  try {
    // Debit runs INSIDE the usageContext scope so it can read the spend
    // accumulator (every `recordUsage` call during `executeJob` increments
    // it). Running the debit outside the scope would read a fresh, zeroed
    // accumulator in a new context and always charge 0 credits — silent
    // but expensive bug. `bgError` swallows debit errors so a DB hiccup
    // can't flip a successful job to failed at this late stage.
    await runInUsageContext(async () => {
      await Promise.race([
        executeJob({
          jobId,
          userId: job.userId.toString(),
          courseId: job.courseId.toString(),
          type: job.type,
          metadata: job.metadata,
        }),
        jobTimeout({ ms: JOB_TIMEOUT_MS, jobId }),
      ]);
      // On success only — failure throws above and skips this block.
      await debitActualSpend({
        userId: job.userId,
        jobId: job._id,
        jobType: job.type,
      }).catch(bgError('jobRunner.debitOnSuccess'));
    });
    status = 'completed';
    jobLog.info(`${job.type}:done jobId=${jobId} ms=${Date.now() - startedAt}`);
  } catch (error: unknown) {
    errorMessage = error instanceof Error ? error.message : String(error);
    jobLog.error(`${job.type}:fail jobId=${jobId} ms=${Date.now() - startedAt} msg=${errorMessage}`);
    Sentry.captureException(error, {
      tags: { source: 'jobRunner', jobType: job.type },
      extra: { jobId, courseId: job.courseId.toString(), metadata: job.metadata },
    });
  } finally {
    // Use findByIdAndUpdate so this is a no-op if the job document was deleted (e.g. course/account deletion)
    await JobModel.findByIdAndUpdate(jobId, {
      status,
      completedAt: new Date(),
      ...(status === 'failed' ? { error: errorMessage } : {}),
    });

    // Always clear activeJobId + activeLesson before emitting WS event so
    // client refetch sees the updated state. activeLesson is only set for
    // generate_lesson submissions, so unsetting unconditionally is safe
    // (no-op when it's already null).
    await CourseModel.findOneAndUpdate(
      { _id: job.courseId, activeJobId: job._id },
      { activeJobId: null, activeLesson: null },
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
