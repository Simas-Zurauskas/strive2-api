import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { TavilySearch } from '@langchain/tavily';
import { Types } from 'mongoose';
import { TAVILY_API_KEY } from '@conf/env';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import UserInsightProgressModel from '@models/UserInsightProgressModel';
import InsightModel from '@models/InsightModel';
import { searchLessonContent } from '@services/lessonRagService';
import { searchProductKb } from '@services/productKbRagService';
import { readUrl } from '@lib/jinaReader';
import { emitHandoffTool } from '../shared/emitHandoffTool';

// ── web_search ────────────────────────────────────────────

export const webSearch = new TavilySearch({
  maxResults: 3,
  tavilyApiKey: TAVILY_API_KEY,
  name: 'web_search',
  description:
    'Search the web for current information about a topic relevant to the lesson. Use when you need to verify a fact, check if something is current, or look up something you are not certain about.',
});

// ── get_user_progress ─────────────────────────────────────
//
// Used by both the lesson mentor and the course mentor. Three scopes:
//   - 'lesson' — progress on a specific lesson (status, quiz responses,
//     exercises). Lesson mentor's default; course mentor uses it when
//     the learner asks about a specific lesson.
//   - 'module' — module quiz score + insights-due count for one module.
//   - 'course' — whole-course picture: per-module quiz scores grouped,
//     total insights due (with module breakdown), lessons completed,
//     days-since-last-activity. Primary scope for the course mentor.
//
// Module/lesson indices come from the tool input (LLM-controlled — it
// can ask about ANY module/lesson, not just the one in scope) or, as
// a fallback, from the configurable context the controller sets up
// (the lesson mentor's "current lesson" indices). Indices in the input
// always win over configurable.

export const getUserProgress = tool(
  async (input, config) => {
    const cfg = config?.configurable ?? {};
    const userId = cfg.userId as string | undefined;
    const courseId = cfg.courseId as string | undefined;
    const cfgModuleIndex = cfg.moduleIndex as number | undefined;
    const cfgLessonIndex = cfg.lessonIndex as number | undefined;

    if (!userId || !courseId) {
      return JSON.stringify({ error: 'Missing context — cannot fetch progress' });
    }

    // Index resolution: explicit input wins over configurable. The course
    // mentor never sets moduleIndex/lessonIndex in configurable, so the
    // model MUST pass them in input when it asks for module/lesson scope.
    const moduleIndex = input.moduleIndex ?? cfgModuleIndex;
    const lessonIndex = input.lessonIndex ?? cfgLessonIndex;

    try {
      if (input.scope === 'lesson') {
        if (moduleIndex === undefined || lessonIndex === undefined) {
          return JSON.stringify({
            error: "scope='lesson' requires moduleIndex and lessonIndex (provide them in tool input).",
          });
        }
        const progress = await UserLessonProgressModel.findOne({
          userId: new Types.ObjectId(userId),
          courseId: new Types.ObjectId(courseId),
          moduleIndex,
          lessonIndex,
        })
          .select('status completedAt timeSpentSeconds bookmarked quizResponses exerciseAttempts')
          .lean();

        if (!progress) {
          return JSON.stringify({ lessonStatus: 'not_started', timeSpentSeconds: 0 });
        }

        const quizCorrect = progress.quizResponses.filter((r) => r.correct).length;
        const quizTotal = progress.quizResponses.length;

        return JSON.stringify({
          moduleIndex,
          lessonIndex,
          lessonStatus: progress.status,
          completedAt: progress.completedAt,
          timeSpentSeconds: progress.timeSpentSeconds,
          bookmarked: progress.bookmarked,
          inLessonQuizScore: quizTotal > 0 ? Math.round((quizCorrect / quizTotal) * 100) : null,
          exercisesAttempted: progress.exerciseAttempts.length,
          exercisesPassed: progress.exerciseAttempts.filter((a) => a.passed).length,
        });
      }

      if (input.scope === 'module') {
        if (moduleIndex === undefined) {
          return JSON.stringify({
            error: "scope='module' requires moduleIndex (provide it in tool input).",
          });
        }
        const quizProgress = await UserModuleQuizProgressModel.findOne({
          userId: new Types.ObjectId(userId),
          courseId: new Types.ObjectId(courseId),
          moduleIndex,
        })
          .select('bestScore bestTier nextReviewAt attempts')
          .lean();

        const insightIds = await InsightModel.distinct('_id', {
          courseId: new Types.ObjectId(courseId),
          moduleIndex,
        }) as Types.ObjectId[];

        const insightsDue = insightIds.length > 0
          ? await UserInsightProgressModel.countDocuments({
              userId: new Types.ObjectId(userId),
              insightId: { $in: insightIds },
              nextDue: { $lte: new Date() },
            })
          : 0;

        return JSON.stringify({
          moduleIndex,
          moduleQuiz: quizProgress
            ? {
                bestScore: quizProgress.bestScore,
                bestTier: quizProgress.bestTier,
                attemptCount: quizProgress.attempts.length,
                reviewDue: quizProgress.nextReviewAt
                  ? quizProgress.nextReviewAt <= new Date()
                  : false,
              }
            : null,
          insightsDueInModule: insightsDue,
        });
      }

      if (input.scope === 'course') {
        const userObjectId = new Types.ObjectId(userId);
        const courseObjectId = new Types.ObjectId(courseId);

        // Three parallel reads: lesson-progress aggregate, module-quiz
        // progress, and insights metadata. We also need a count of due
        // insights per-module — that's a follow-up read keyed off the
        // insight ids.
        const [lessonProgressAgg, moduleQuizzes, insightsByModule] = await Promise.all([
          UserLessonProgressModel.aggregate<{
            _id: { moduleIndex: number; lessonIndex: number };
            status: string;
            completedAt?: Date;
          }>([
            {
              $match: {
                userId: userObjectId,
                courseId: courseObjectId,
              },
            },
            {
              $group: {
                _id: { moduleIndex: '$moduleIndex', lessonIndex: '$lessonIndex' },
                status: { $first: '$status' },
                completedAt: { $max: '$completedAt' },
              },
            },
          ]),
          UserModuleQuizProgressModel.find({
            userId: userObjectId,
            courseId: courseObjectId,
          })
            .select('moduleIndex bestScore bestTier nextReviewAt attempts')
            .lean(),
          InsightModel.aggregate<{ _id: number; insightIds: Types.ObjectId[] }>([
            { $match: { courseId: courseObjectId } },
            {
              $group: {
                _id: '$moduleIndex',
                insightIds: { $push: '$_id' },
              },
            },
          ]),
        ]);

        const insightsDuePerModule: { moduleIndex: number; due: number }[] = [];
        let totalInsightsDue = 0;
        for (const row of insightsByModule) {
          const due = row.insightIds.length > 0
            ? await UserInsightProgressModel.countDocuments({
                userId: userObjectId,
                insightId: { $in: row.insightIds },
                nextDue: { $lte: new Date() },
              })
            : 0;
          if (due > 0) {
            insightsDuePerModule.push({ moduleIndex: row._id, due });
            totalInsightsDue += due;
          }
        }

        const lessonsCompleted = lessonProgressAgg.filter((l) => l.status === 'completed').length;
        const lessonsInProgress = lessonProgressAgg.filter((l) => l.status === 'in_progress').length;

        const lastActivityDate = lessonProgressAgg
          .map((l) => l.completedAt)
          .filter((d): d is Date => d instanceof Date)
          .sort((a, b) => b.getTime() - a.getTime())[0];

        const daysSinceLastActivity = lastActivityDate
          ? Math.floor((Date.now() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24))
          : null;

        return JSON.stringify({
          lessonsCompleted,
          lessonsInProgress,
          daysSinceLastActivity,
          moduleQuizzes: moduleQuizzes.map((q) => ({
            moduleIndex: q.moduleIndex,
            bestScore: q.bestScore,
            bestTier: q.bestTier,
            attemptCount: q.attempts.length,
            reviewDue: q.nextReviewAt ? q.nextReviewAt <= new Date() : false,
          })),
          insightsDuePerModule,
          totalInsightsDue,
        });
      }

      return JSON.stringify({ error: 'Unknown scope' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  },
  {
    name: 'get_user_progress',
    description:
      "Fetch the learner's progress data. Use 'lesson' scope for one lesson's status/quiz responses (requires moduleIndex+lessonIndex), 'module' scope for one module's quiz score and insights-due count (requires moduleIndex), 'course' scope for the whole-course picture (per-module quiz scores grouped, total insights due, lessons completed, days since last activity).",
    schema: z.object({
      scope: z
        .enum(['lesson', 'module', 'course'])
        .describe("'lesson' for one lesson, 'module' for one module, 'course' for the whole course"),
      moduleIndex: z
        .number()
        .optional()
        .describe("Required when scope='module' or scope='lesson'."),
      lessonIndex: z
        .number()
        .optional()
        .describe("Required when scope='lesson'."),
    }),
  },
);

// ── search_lesson_content ─────────────────────────────────
//
// Vector search over the entire course's indexed lesson content. Use this
// (instead of relying solely on the lesson markdown injected in the system
// prompt) when:
//   - the learner references something from a previous lesson/module
//   - the learner asks a question that may be answered by content the
//     mentor doesn't have in immediate context
//   - the current lesson hasn't been generated yet but other lessons in
//     the course have
//
// Falls through to an empty result string when RAG is disabled, so the
// mentor degrades gracefully to "lesson markdown in system prompt only".

export const searchLessonContentTool = tool(
  async (input, config) => {
    const { courseId } = config?.configurable ?? {};
    if (!courseId) {
      return JSON.stringify({ error: 'Missing courseId in tool context' });
    }

    const results = await searchLessonContent({
      courseId,
      query: input.query,
      moduleIndex: input.moduleIndex,
      topK: 5,
    });

    if (results.length === 0) {
      return JSON.stringify({
        results: [],
        note: 'No indexed content matched. Either RAG is disabled, no lessons in this course have been indexed yet, or the query is too far from any chunk.',
      });
    }

    return JSON.stringify({
      results: results.map((r) => ({
        moduleIndex: r.moduleIndex,
        lessonIndex: r.lessonIndex,
        blockType: r.blockType,
        score: Math.round(r.score * 1000) / 1000,
        text: r.text.length > 1200 ? r.text.slice(0, 1200) + '…' : r.text,
      })),
    });
  },
  {
    name: 'search_lesson_content',
    description:
      "Search the course's indexed lesson content via vector similarity. Use when the learner references material from another lesson, asks something that might be in the broader course, or you need to verify a recall against the source material. Returns up to 5 ranked chunks with their lesson/module location.",
    schema: z.object({
      query: z.string().describe('The natural-language question or concept to search for.'),
      moduleIndex: z
        .number()
        .optional()
        .describe('Optional: restrict search to a specific module index. Omit to search the entire course.'),
    }),
  },
);

// ── search_product_kb ─────────────────────────────────────
//
// Vector search over Strive's product help center. Use when the learner
// asks a *meta* question — about Strive itself, billing, account,
// teaching techniques, mastery measurement, the Insights queue, the
// streak, etc. — rather than a question about the course content. The
// distinction matters: search_lesson_content is for "what does the
// lesson say about X?", search_product_kb is for "how does Strive's
// X work?". Returns up to 3 ranked excerpts with article href so the
// mentor can cite via inline markdown links.

export const searchProductKbTool = tool(
  async (input) => {
    const results = await searchProductKb({ query: input.query, topK: 3 });
    if (results.length === 0) {
      return JSON.stringify({
        results: [],
        note: 'No help-center match. The product KB may not cover this topic — say so honestly rather than inventing details.',
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
      "Search Strive's product help center via vector similarity. Use ONLY for product-meta questions: how Strive itself works (billing, allowance, course creation, lessons, mentor, narration, spaced review, mastery, achievements). DO NOT use for course-content questions — use search_lesson_content for those. Returns up to 3 ranked excerpts with the article href; cite via inline markdown links.",
    schema: z.object({
      query: z
        .string()
        .describe('Natural-language question about how Strive works as a product.'),
    }),
  },
);

// ── fetch_url ─────────────────────────────────────────────
//
// Given a URL the learner pasted (or one the agent decides is worth
// reading), use Jina Reader to extract the main text content. Capped at
// 8K chars per fetch — enough for the mentor to discuss the gist without
// blowing the chat context. Returns a structured error code on failure
// so the model can apologise concretely ("the page returned 404" vs "the
// URL was unsafe to fetch").

const READ_URL_ERROR_MESSAGES: Record<string, string> = {
  invalid_url: 'The URL is missing or malformed.',
  unsafe_url: 'That URL is not safe to fetch (private network or non-http(s) scheme).',
  timeout: 'The page took too long to load (>10s).',
  http_error: 'The page returned an HTTP error.',
  empty_body: 'The page returned no readable content.',
};

export const fetchUrlTool = tool(
  async (input) => {
    const result = await readUrl({ url: input.url, action: 'mentor:fetch_url' });

    if (!result.ok) {
      return JSON.stringify({
        url: input.url,
        error: result.error,
        message: READ_URL_ERROR_MESSAGES[result.error] ?? 'Could not fetch the page.',
      });
    }

    return JSON.stringify({
      url: result.data.url,
      tokens: result.data.tokens,
      truncated: result.data.truncated,
      text: result.data.text,
    });
  },
  {
    name: 'fetch_url',
    description:
      "Fetch the main-text content of a public web page via Jina Reader. Use when the learner pastes a URL (article, paper, doc) and asks you to read or discuss it, OR when you genuinely need to read external material to answer their question accurately. Returns up to 8K chars of extracted text. Do NOT use for course-internal questions — prefer search_lesson_content for those.",
    schema: z.object({
      url: z.string().describe('A fully-qualified http(s) URL of a public web page.'),
    }),
  },
);

// ── Export all tools ──────────────────────────────────────

export const TOOLS = [webSearch, getUserProgress, searchLessonContentTool, searchProductKbTool, fetchUrlTool, emitHandoffTool];
