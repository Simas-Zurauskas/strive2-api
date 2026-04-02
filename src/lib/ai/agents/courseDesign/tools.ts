import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { TavilySearch } from '@langchain/tavily';
import { submitJob } from '@services/jobRunner';
import { jobEvents } from '@services/jobEvents';
import CourseModel from '@models/CourseModel';
import { TAVILY_API_KEY } from '@conf/env';

/** Wait for a job to complete via in-process EventEmitter (no DB polling). */
const waitForJob = (
  jobId: string,
  timeoutMs = 120000,
  abortSignal?: AbortSignal,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      jobEvents.removeListener(`job:${jobId}`, handler);
      abortSignal?.removeEventListener('abort', onAbort);
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Job timed out'));
    }, timeoutMs);

    const handler = (payload: { status: string; error?: string }) => {
      cleanup();
      if (payload.status === 'completed') resolve();
      else reject(new Error(payload.error ?? 'Job failed'));
    };

    const onAbort = () => {
      cleanup();
      reject(new Error('Client disconnected'));
    };

    if (abortSignal?.aborted) {
      reject(new Error('Client disconnected'));
      return;
    }

    abortSignal?.addEventListener('abort', onAbort, { once: true });
    jobEvents.once(`job:${jobId}`, handler);
  });
};

// ── modify_structure ──────────────────────────────────────

export const modifyStructure = tool(
  async (input, config) => {
    console.log('[tool:modify_structure] ── Called ──'.cyan);
    console.log(`[tool:modify_structure] instruction: ${input.instruction.slice(0, 120)}`.gray);
    const { courseId, userId, goal, answers, depth, currentStructure, abortSignal } = config?.configurable ?? {};

    if (!goal || !currentStructure || !courseId || !userId) {
      console.error('[tool:modify_structure] ✗ Missing course context'.red);
      return JSON.stringify({ success: false, error: 'Missing course context' });
    }

    try {
      // Store feedback on Course for the job processor to read
      await CourseModel.findByIdAndUpdate(courseId, { pendingFeedback: input.instruction });

      // Submit a refine_structure job (reads all data from Course)
      const jobId = await submitJob({
        userId,
        courseId,
        type: 'refine_structure',
      });

      console.log(`[tool:modify_structure] ✓ Job submitted: ${jobId}`.green);

      // Wait for job to complete (client receives status via WebSocket)
      await waitForJob(jobId, 120000, abortSignal as AbortSignal | undefined);

      // Read updated course from DB (result is written to Course during job execution)
      const updatedCourse = await CourseModel.findById(courseId).select('name structure').lean();
      const structure = updatedCourse?.structure as { reasoning?: unknown; modules?: unknown[] } | undefined;

      if (structure && config?.configurable) {
        config.configurable.currentStructure = structure;
      }

      console.log(`[tool:modify_structure] ✓ Job completed — ${structure?.modules?.length ?? 0} modules`.green);
      return JSON.stringify({
        success: true,
        courseName: updatedCourse?.name,
        modules: structure?.modules,
        reasoning: structure?.reasoning,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tool:modify_structure] ✗ Error: ${message}`.red);
      return JSON.stringify({ success: false, error: message });
    }
  },
  {
    name: 'modify_structure',
    description:
      'Modifies the course structure based on a natural language instruction. Use this when the user asks to add, remove, reorder, merge, split, or change modules or lessons. Returns the updated structure.',
    schema: z.object({
      instruction: z
        .string()
        .describe(
          'A clear, specific instruction for how to modify the course structure. E.g., "Remove module 3 and add more focus on testing" or "Split the React module into two: basics and hooks"',
        ),
    }),
  },
);

// ── web_search ────────────────────────────────────────────

export const webSearch = new TavilySearch({
  maxResults: 3,
  tavilyApiKey: TAVILY_API_KEY,
  name: 'web_search',
  description:
    'Search the web for current information about technologies, frameworks, best practices, or any topic relevant to course design. Use when you need to verify facts, check if something is current, or research a topic you are uncertain about.',
});

// ── Export all tools ──────────────────────────────────────

export const TOOLS = [modifyStructure, webSearch];
