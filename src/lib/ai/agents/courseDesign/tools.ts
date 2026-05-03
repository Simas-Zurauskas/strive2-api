import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { TavilySearch } from '@langchain/tavily';
import { refineCourseStructure } from '@services/courseService';
import { cleanupCourseContent } from '@services/courseCleanupService';
import { searchProductKb } from '@services/productKbRagService';
import CourseModel from '@models/CourseModel';
import LessonContentModel from '@models/LessonContentModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import { TAVILY_API_KEY } from '@conf/env';
import { CourseDepth, CourseDomain, GoalType } from '@lib/constants';
import { generateUniqueSlug } from '@lib/slugify';
import { chatLog } from '@lib/loggers';
import { regenerateAndPersistDesignPrompts } from './promptsGenerator';

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
      // Load feedback history, current domain, goalType, and check for existing content/progress
      const course = await CourseModel.findById(courseId).select('feedbackHistory userId domain goalType').lean();
      const feedbackHistory = (course?.feedbackHistory as string[]) ?? [];
      const currentDomain = (course?.domain as CourseDomain | null | undefined) ?? null;
      const goalType = ((course?.goalType as GoalType | null | undefined) ?? 'master') as GoalType;

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
        goalType,
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

      // Refresh the suggested chat prompts in the background — the
      // structure they were anchored to just changed, so stale prompts
      // would defeat the value of having them. Fire-and-forget: the
      // user's current chat turn shouldn't wait on the refresh, and
      // errors are swallowed inside the helper. Stale prompts will
      // surface until the client's next history fetch.
      void regenerateAndPersistDesignPrompts(courseId);

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

// ── search_product_kb ─────────────────────────────────────
//
// Vector search over Strive's help center. Use ONLY when the user asks
// a meta question about Strive itself ("what is Strive good at?", "how
// do credits work?", "what does spaced review actually do?") — never
// to source course content. Returns ranked excerpts with article href
// so the agent can cite via inline markdown links.

export const searchProductKbTool = tool(
  async (input) => {
    const results = await searchProductKb({ query: input.query, topK: 3 });
    if (results.length === 0) {
      return JSON.stringify({
        results: [],
        note: 'No help-center match. Say so honestly rather than inventing platform details.',
      });
    }
    return JSON.stringify({
      results: results.map((r) => ({
        articleTitle: r.articleTitle,
        sectionPath: r.sectionPath,
        href: r.href,
        score: Math.round(r.score * 1000) / 1000,
        text: r.text.length > 1200 ? r.text.slice(0, 1200) + '…' : r.text,
      })),
    });
  },
  {
    name: 'search_product_kb',
    description:
      "Search Strive's help center for facts about the platform itself: how credits/billing work, how spaced review or mastery works, what plans exist, what Strive is good at, what features are available. DO NOT use this to inform the COURSE content the user is asking you to build — only use for product-meta questions.",
    schema: z.object({
      query: z
        .string()
        .describe('Natural-language question about how Strive works as a platform.'),
    }),
  },
);

// ── Export all tools ──────────────────────────────────────

export const TOOLS = [modifyStructure, webSearch, searchProductKbTool];
