import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { TavilySearch } from '@langchain/tavily';
import { refineCourseStructure } from '@services/courseService';
import { cleanupCourseContent } from '@services/courseCleanupService';
import CourseModel from '@models/CourseModel';
import LessonContentModel from '@models/LessonContentModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import { TAVILY_API_KEY } from '@conf/env';
import { CourseDepth, CourseDomain } from '@lib/constants';
import { generateUniqueSlug } from '@lib/slugify';
import { chat as chatLog } from '@lib/loggers';

// ── modify_structure ──────────────────────────────────────

export const modifyStructure = tool(
  async (input, config) => {
    const toolStart = Date.now();
    chatLog.info(
      `design:tool start name=modify_structure instruction=${JSON.stringify(input.instruction.slice(0, 120))}`,
    );
    const { courseId, goal, answers, depth, currentStructure } = config?.configurable ?? {};

    if (!goal || !currentStructure || !courseId) {
      chatLog.error(
        `design:tool done name=modify_structure ms=${Date.now() - toolStart} ok=false err=missing-context`,
      );
      return JSON.stringify({ success: false, error: 'Missing course context' });
    }

    try {
      // Load feedback history, current domain, and check for existing content/progress
      const course = await CourseModel.findById(courseId).select('feedbackHistory userId domain').lean();
      const feedbackHistory = (course?.feedbackHistory as string[]) ?? [];
      const currentDomain = (course?.domain as CourseDomain | null | undefined) ?? null;

      const [contentCount, progressCount] = await Promise.all([
        LessonContentModel.countDocuments({ courseId }),
        UserLessonProgressModel.countDocuments({ courseId }),
      ]);
      const hasExistingContent = contentCount > 0 || progressCount > 0;

      // Call refineCourseStructure directly (skip the job system for inline chat operations)
      const result = await refineCourseStructure({
        goal,
        answers: answers ?? [],
        depth: (depth as CourseDepth) ?? 'comprehensive',
        currentStructure,
        currentDomain,
        feedback: input.instruction,
        feedbackHistory,
      });

      // Persist the updated structure and feedback history
      await CourseModel.findByIdAndUpdate(courseId, {
        name: result.courseName,
        slug: await generateUniqueSlug({ userId: course!.userId.toString(), name: result.courseName }),
        domain: result.domain,
        structure: { reasoning: result.reasoning, modules: result.modules },
        feedbackHistory: [...feedbackHistory, input.instruction],
        pendingFeedback: null,
      });

      // Clean up orphaned content/progress if structure changed on a course with existing data
      if (hasExistingContent) {
        await cleanupCourseContent(courseId);
      }

      // Update in-memory state for the next chat turn
      if (config?.configurable) {
        config.configurable.currentStructure = { reasoning: result.reasoning, modules: result.modules };
      }

      chatLog.info(
        `design:tool done name=modify_structure ms=${Date.now() - toolStart} ok=true modules=${result.modules.length}${hasExistingContent ? ' contentCleared=true' : ''}`,
      );
      return JSON.stringify({
        success: true,
        courseName: result.courseName,
        modules: result.modules,
        reasoning: result.reasoning,
        contentCleared: hasExistingContent,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      chatLog.error(
        `design:tool done name=modify_structure ms=${Date.now() - toolStart} ok=false err=${message}`,
      );
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
