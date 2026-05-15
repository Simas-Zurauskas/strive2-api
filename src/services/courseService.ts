import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import { getStructureModel, MODEL_IDS } from '@lib/langchain';
import { cachedSystemMessage } from '@lib/ai/cacheControl';
import { logCacheUsage, usageFromAnthropic } from '@lib/ai/cacheLogger';
import { withRetry } from '@lib/retry';
import { jsonish } from '@lib/zodHelpers';
import { ANTHROPIC_API_KEY } from '@conf/env';
import {
  COURSE_DEPTHS,
  COURSE_DOMAINS,
  CourseDepth,
  CourseDomain,
  GOAL_TYPES,
  GOAL_TYPE_CONFIDENCES,
  GoalType,
  GoalTypeConfidence,
  QUESTION_TYPES,
} from '@lib/constants';
import { sanitizePromptInput } from '@lib/sanitize';
import { bumpClarifyRefinementRetry, bumpStructureCapExceeded } from '@lib/metrics';
import { genLog } from '@lib/loggers';
import { detectSoftnessHint, getLessonCountHint, getEstimatedHoursRange, SoftnessHint } from './softness';
import {
  clarifyOutputSchema,
  ClarifyOutput,
  CLARIFY_TEXT_QUESTION_REFINEMENT_MARKER,
} from './clarifyValidation';
import {
  goalTypeClassificationSchema,
  GoalTypeClassification,
  GOAL_TYPE_GUIDANCE,
  fallbackClassification,
} from './goalTypeClassification';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Per-call stall ceiling for every Anthropic / LangChain call in this
// module. The Anthropic SDK's default request timeout is 10 minutes,
// which is also the outer `JOB_TIMEOUT_MS` cap — so without this, a
// degraded API can pin a `pLimit` slot for the full job timeout. 180 s
// is generous: Sonnet generating a long course structure routinely
// takes 60–120 s on healthy days, so this only fires on genuine stalls.
// Combined with `withRetry`'s 3 attempts, the worst-case per-step
// wall time becomes 3 × 180 s = 9 min — still inside the 10 min job
// budget, with headroom for surrounding orchestration. This is a
// stall-protection cap, NOT a normal-flow latency target — do not
// lower it without re-verifying p99 generation latency under load.
const ANTHROPIC_PER_CALL_TIMEOUT_MS = 180_000;

const withCallTimeout = async <T>(
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_PER_CALL_TIMEOUT_MS);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
};

// Re-export from the validation module so existing importers (jobRunner.ts)
// continue working without a mechanical import refactor.
export { clarifyOutputSchema, isThinFreeText } from './clarifyValidation';
export { goalTypeClassificationSchema, GoalTypeClassification } from './goalTypeClassification';

// ── Classify goalType ───────────────────────────────────
//
// One-shot Haiku call run inside the `clarify` job, BEFORE the clarifying
// questions are generated. The output (`goalType`) tilts the clarify
// question set and later steers the structure prompt's curriculum-shape
// rules. Failure mode is graceful: any error or schema-validation miss
// returns the safe default `{ goalType: 'master', confidence: 'low', ... }`
// so a Haiku hiccup never fails the clarify job.

const GOAL_TYPE_GUIDANCE_BULLETS = GOAL_TYPES.map(
  (t) => `- "${t}": ${GOAL_TYPE_GUIDANCE[t]}`,
).join('\n');

const GOAL_TYPE_CLASSIFIER_PROMPT = `You classify a learning goal into ONE of: master | monetize | pass | build | fluency. Your classification steers downstream curriculum shape, so be precise.

Definitions:
${GOAL_TYPE_GUIDANCE_BULLETS}

Apply a primary-activity test for multi-intent goals (when a goal could plausibly fit two types, pick the one whose deliverable IS the goal):
- "Learn React deeply to ship a SaaS" → build (the SaaS is the deliverable; React is the means).
- "Become a YouTuber making React tutorials" → monetize (the channel is the goal; React is the topic of the channel).
- "Master React" → master (no project, no channel, no exam).
- "Learn Spanish before my Madrid trip" → fluency (NOT pass — no exam).
- "Pass AWS Solutions Architect by November" → pass (named cert + date).
- "Build a Chrome extension to track tabs" → build (the extension is the project).
- "Run Meta ads for my silver-jewelry ecomm store" → monetize (revenue is the goal).
- "Become fluent in conversational Japanese for travel" → fluency.
- "Gasu" / "fre fire" / unparseable fragments → master with confidence: low.

Workplace deliverables also count as build (commonly mis-classified as master because the topic name is prominent — DON'T fall for it):
- "Learn Kubernetes for a production migration at work, already know Docker basics" → build (the migration is the deliverable).
- "Learn Spring Boot to refactor our payments service" → build (the refactor is the deliverable).
- "Learn Terraform to set up our staging infrastructure pipeline" → build (the pipeline is the deliverable).
- "Learn Rust to port our API server" → build (the port is the deliverable).
- "Learn Snowflake for our data-warehouse migration this quarter" → build (the migration is the deliverable).
The signal is a named workplace artifact ("our X", "the X migration / rollout / refactor / port") that the learning is in service of. If the goal mentions ONLY the topic with no workplace deliverable ("master Kubernetes", "deeply understand Terraform"), classify as master.

Also extract a short, learner-facing NOUN PHRASE for chip display (4-10 words, concrete, quotes the learner's own phrasing when present):
- "become a YouTuber making cooking videos" → "your cooking YouTube channel"
- "pass the CPA audit exam in October" → "the CPA audit exam"
- "build a real-time chat app in React" → "your real-time chat app"
- "become fluent in Japanese" → "Japanese"
- "master functional programming in Haskell" → "functional programming in Haskell"

Confidence:
- high: the primary-activity signal is explicit in the goal text.
- medium: the signal is implied but not stated.
- low: vague, garbled, non-English, OR could plausibly be 2+ types.

Return your output via the classify_goal_type tool.`;

const GOAL_TYPE_CLASSIFIER_TOOL: Anthropic.Messages.Tool = {
  name: 'classify_goal_type',
  description: "Classify the learner's goal into a goalType axis with a chip noun phrase.",
  input_schema: {
    type: 'object',
    properties: {
      goalType: { type: 'string', enum: [...GOAL_TYPES] },
      confidence: { type: 'string', enum: [...GOAL_TYPE_CONFIDENCES] },
      noun: { type: 'string', description: '4-10 word noun phrase for the goal-type chip on the ClarifyStep.' },
    },
    required: ['goalType', 'confidence', 'noun'],
  },
};

export const classifyGoalType = async (params: { goal: string }): Promise<GoalTypeClassification> => {
  const goal = sanitizePromptInput(params.goal);
  try {
    const result = await withCallTimeout((signal) => anthropic.messages.create({
      model: MODEL_IDS.HAIKU,
      max_tokens: 256,
      temperature: 0,
      system: [
        {
          type: 'text',
          text: GOAL_TYPE_CLASSIFIER_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: goal }],
      tools: [GOAL_TYPE_CLASSIFIER_TOOL],
      tool_choice: { type: 'tool', name: GOAL_TYPE_CLASSIFIER_TOOL.name },
    }, { signal }));

    logCacheUsage({
      label: 'clarify:goalType',
      usage: usageFromAnthropic(result),
      model: MODEL_IDS.HAIKU,
    });

    const toolUse = result.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolUse) {
      genLog.warn('classifyGoalType: model emitted no tool_use; falling back to master/low');
      return fallbackClassification(goal);
    }
    const parsed = goalTypeClassificationSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      genLog.warn(
        `classifyGoalType: schema parse failed (${parsed.error.message}); falling back to master/low`,
      );
      return fallbackClassification(goal);
    }
    genLog.info(
      `classifyGoalType result goalType=${parsed.data.goalType} confidence=${parsed.data.confidence}`,
    );
    return parsed.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    genLog.warn(`classifyGoalType failed (${msg}); falling back to master/low`);
    return fallbackClassification(goal);
  }
};

// ── Clarify course ──────────────────────────────────────

const CLARIFY_SYSTEM_PROMPT = `You are a world-class curriculum designer and learning scientist. You specialize in personalized education — designing curricula that adapt to each individual learner's background, goals, and constraints.

Your task: Given a learning goal, generate a concise course title and 3-6 clarifying questions whose answers will most significantly change the resulting curriculum. Think like a skilled tutor meeting a new student for the first time — you need to quickly understand who they are and what they actually need. Prefer fewer, higher-impact questions. Only go beyond 4 if the topic genuinely has that many discriminating dimensions.

First, generate a courseName (2-6 words) — a concise, descriptive title for the course based on the learning goal. Make it specific and professional: "Python for Data Science" not "Learn Python."

Before generating questions, reason about:
- What are the major branches or specializations within this topic?
- What prior knowledge dramatically changes the starting point?
- What are the most common reasons people learn this topic, and how do those reasons change what should be taught?
- What constraints (time, tools, environment) would meaningfully affect the curriculum design?

Principles for high-quality questions:
- Each question must be DISCRIMINATING — different answers should produce meaningfully different curricula. If all answers lead to roughly the same course, the question is wasted.
- Questions should demonstrate deep domain knowledge. For "Learn Python," don't ask generic questions — ask about specific Python ecosystems (data science vs web vs automation vs scripting) because these are entirely different curricula.
- Avoid formulaic patterns. Do NOT ask "how many hours per week can you study" — this rarely changes what modules to include. Instead ask questions that reveal WHAT to teach, not scheduling logistics.
- Every question must be CONCRETE and SIMPLE — answerable in under 5 seconds. Never ask abstract or meta questions like "What challenges do you anticipate?" or "What constraints do you face?" — learners don't know what they don't know. Ask specific, factual questions: "What tools do you already use?" not "What constraints affect your tool choice?"
- Options must use language the LEARNER knows, not expert jargon. If someone says they're a beginner, don't offer options like "AI-driven prototyping tools" — use plain language like "Figma", "Canva", "Adobe XD."
- Default to multiple_select over multiple_choice. Most real-world answers are NOT mutually exclusive. Only use multiple_choice when options are truly exclusive (e.g., experience level where you can only be one: beginner OR intermediate OR advanced).
- You MUST include AT LEAST ONE "text" question in every clarify set — this is a hard requirement, not a preference. Typically 1-2 text questions, more if the goal is domain-specific, professional, or highly personal. A well-scoped text question elicits a concrete artifact (a specific project, stakeholder, constraint, prior tool, dataset, or domain-concrete detail) that the curriculum can thread through lessons and examples; MCQ options cannot substitute because they flatten the learner's specifics into invented choices. Good text-question examples: "What's the specific project or problem you want to solve?", "Who is your audience — describe them briefly", "What prior tools or frameworks have you already used?". If the topic feels fully multi-choice, you are wrong — ask for the context (use case, team setup, prior attempt, specific deliverable). NEVER ship a clarify set with zero text questions.

Question types — pick the best type for each question:
- "multiple_select": PREFERRED for list-like answers. One or more options. Use for topics of interest, tools, skills, goals — anything where the learner might want to pick several. Provide 4-6 options. Set options array.
- "multiple_choice": One option only. ONLY for truly mutually exclusive choices (experience level, primary learning format preference). Provide 3-5 options. Set options array.
- "text": Free-form answer. Use for open-ended answers where a concrete phrase from the learner — a project name, a specific tool, a stakeholder, a constraint — will materially improve curriculum design. Set options to null.

Each question must have a unique id (q1, q2, q3, etc).

Goal-type tilt — the learner's goal has been pre-classified into one of master | monetize | pass | build | fluency, and the goalType is included in the user message. The user message ALSO repeats the tilt directive specific to this goal — that directive is non-negotiable. Adjust your questions so they elicit information specific to that intent shape:
- master — keep the questions general (background, prior tools, focus areas, learning format). This is the default behavior. ADDITIONALLY: when the goal could plausibly be interpreted at very different reading levels — e.g. "Learn math" (a first-grader and a grad student both fit) or "Understand AI" (a curious 12-year-old and a senior engineer both fit) — include ONE text question that elicits the audience: who the lesson is FOR (themself? a child of a specific age? a team? a non-technical stakeholder?), and at what level. Skip this only when the goal already names the audience or level (e.g. "Calculus for engineers", "Spanish A2 → B1") — adding it then is redundant.
- monetize — at LEAST ONE question MUST elicit the learner's PRODUCT, NICHE, AUDIENCE, or CHANNELS. Other questions can ask about current revenue, marketing budget, or stage. ❌ Wrong: "What topics interest you most?" ✅ Right: "What's your product or niche, and who are you trying to reach?"
- pass — at LEAST ONE question MUST elicit the EXAM NAME and (if not already in the goal) the DATE or DEADLINE. Other questions can ask about weak topics, past papers available, target score. ❌ Wrong: "How experienced are you?" ✅ Right: "Which exam, and what's your test date?"
- build — at LEAST ONE question MUST elicit the PROJECT SCOPE or specific deliverable detail (the named project / migration / refactor / port the learner is shipping). Other questions can ask about tech-stack constraints, MVP deadline, or target users. ❌ Wrong: "What concepts interest you?" ✅ Right: "What's the simplest version of your project that you'd ship first?" or "What's the minimum migration milestone for week 2?"
- fluency — at LEAST ONE question MUST elicit BOTH the TARGET CEFR LEVEL or fluency target (conversational A2, business B2, academic C1, etc.) AND the learner's CURRENT level. Other questions can ask about practice time, immersion context, or specific scenarios. ❌ Wrong: "How much time can you dedicate per week?" alone. ✅ Right: "What's your current level (A1 / A2 / B1 / B2 / C1) and the level you're targeting?"

Self-check before emitting: open your generated questions and locate the tilt-required content for THIS goalType. If it's missing, rewrite. The hard contract — at least one text question — still applies for every goalType.`;

// Tool schema for the clarify generation. Mirrors `clarifyOutputSchema` so
// the tool_use payload passes Zod validation after parsing. Hand-written
// (not derived via `z.toJSONSchema`) so the Anthropic tool definition stays
// flat and predictable — no anyOf noise from `jsonish()` wrappers at the
// tool root, which has been correlated with empty tool_use emissions
// elsewhere in the codebase (see zodHelpers.ts:jsonish guidance).
const CLARIFY_TOOL: Anthropic.Messages.Tool = {
  name: 'clarify_output',
  description:
    "Return the generated course name and the learner's clarifying questions.",
  input_schema: {
    type: 'object',
    properties: {
      courseName: { type: 'string', description: '2-6 word course title.' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique id (q1, q2, q3, …).' },
            question: { type: 'string' },
            type: { type: 'string', enum: [...QUESTION_TYPES] },
            options: {
              anyOf: [
                { type: 'array', items: { type: 'string' } },
                { type: 'null' },
              ],
              description:
                'Array of option strings for multiple_choice/multiple_select; null for text.',
            },
          },
          required: ['id', 'question', 'type', 'options'],
        },
      },
    },
    required: ['courseName', 'questions'],
  },
};

// Per-goalType tilt directive duplicated into the user message. The
// system-prompt tilt section is comprehensive but lives ~200 lines deep —
// in production we observed Haiku quietly dropping the fluency/build/pass
// MUST-elicit rules. Repeating the rule for THIS goal in the user message
// (the last thing the model reads before generating) raises adherence
// without inflating the cached system prompt for other goalTypes. Wording
// stays imperative: "MUST" + a concrete-form example.
const CLARIFY_USER_MESSAGE_TILT_DIRECTIVE: Record<GoalType, string> = {
  master:
    'No special tilt — keep the questions general (background, prior tools, focus areas, learning format).',
  monetize:
    'TILT REQUIRED for goalType=monetize: at LEAST ONE question MUST elicit the learner\'s PRODUCT, NICHE, AUDIENCE, or CHANNELS by name. Example shape: "What\'s your product or niche, and who are you trying to reach?"',
  pass:
    'TILT REQUIRED for goalType=pass: at LEAST ONE question MUST elicit the EXAM NAME (if not already stated) and the TEST DATE / DEADLINE. Example shape: "Which exam, and what\'s your test date?"',
  build:
    'TILT REQUIRED for goalType=build: at LEAST ONE question MUST elicit the SPECIFIC DELIVERABLE — the project / migration / refactor / port the learner is shipping — and its scope or first milestone. Example shape: "What\'s the deliverable (the project / migration / system) and the first milestone you\'d ship?"',
  fluency:
    'TILT REQUIRED for goalType=fluency: at LEAST ONE question MUST elicit BOTH the learner\'s CURRENT CEFR level AND their TARGET CEFR level (or named fluency target like "business" / "conversational" / "academic"). Example shape: "What\'s your current level (A1 / A2 / B1 / B2 / C1) and the level you\'re targeting?"',
};

export const clarifyCourse = async (params: { goal: string; goalType?: GoalType }): Promise<ClarifyOutput> => {
  const goal = sanitizePromptInput(params.goal);
  const goalType = params.goalType ?? 'master';

  // The user message carries goal + goalType + the per-goalType tilt
  // directive. The directive is duplicated from the system prompt's tilt
  // section (which lives further from the model's attention) — repeating it
  // here raises adherence on goalTypes other than master (observed Haiku
  // dropping fluency/build/pass MUST-elicit rules). Pre-feature courses
  // that don't pass `goalType` default to `master`, whose directive is the
  // explicit "no tilt" line — no regression on the working path.
  const userMessage = `Learning goal: ${goal}\n\nGoal type: ${goalType}\n\n${CLARIFY_USER_MESSAGE_TILT_DIRECTIVE[goalType]}`;

  // Raw Anthropic SDK (not LangChain `.withStructuredOutput`) so we keep the
  // explicit tool_use contract and targeted cache breakpoint.
  //
  // Model: Haiku, switched from Sonnet as part of the 2026-04-21 cost audit.
  // Clarify is structured tool_use with a constrained output (3-6 questions
  // of known types) — Haiku handles this reliably at temperature 0.7, and the
  // withRetry wrapper catches the rare parse miss. Prompt caching is a no-op
  // here (system + tools ~1300 tok is below Haiku's 2048-tok minimum), so
  // the cache_control annotation is retained only for defensive consistency
  // with the cacheControl helper contract — no effective prefix hit on Haiku.
  const response = await withRetry(async () => {
    try {
      const result = await withCallTimeout((signal) => anthropic.messages.create({
        model: MODEL_IDS.HAIKU,
        max_tokens: 4096,
        temperature: 0.7,
        system: [
          {
            type: 'text',
            text: CLARIFY_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userMessage }],
        tools: [CLARIFY_TOOL],
        tool_choice: { type: 'tool', name: CLARIFY_TOOL.name },
      }, { signal }));

      logCacheUsage({ label: 'clarify:questions', usage: usageFromAnthropic(result), model: MODEL_IDS.HAIKU });

      const toolUse = result.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );
      if (!toolUse) {
        throw new Error('clarify: model did not emit a tool_use block');
      }

      // Zod preserves the `.refine()` contract (≥1 text question). On failure
      // the thrown ZodError carries CLARIFY_TEXT_QUESTION_REFINEMENT_MARKER so
      // the catch below bumps the refinement-retry counter.
      return clarifyOutputSchema.parse(toolUse.input);
    } catch (e) {
      // Detect refinement-triggered retries separately from generic JSON-parse
      // failures so `/metrics` exposes a clean "how often does the LLM ignore
      // the hard-contract text-question rule" signal. withRetry then handles
      // the actual backoff + re-invocation.
      if (e instanceof Error && e.message.includes(CLARIFY_TEXT_QUESTION_REFINEMENT_MARKER)) {
        bumpClarifyRefinementRetry();
      }
      throw e;
    }
  });

  return response;
};

// ── Shared helpers ──────────────────────────────────────

const formatAnswers = (answers: { questionId: string; answer: string }[]) =>
  answers.map((a) => `- ${a.questionId}: ${sanitizePromptInput(a.answer)}`).join('\n');

/**
 * Render the softness signal block consumed by both the depth-previews and
 * structure-generation prompts. Always emits the SOFT= line so the LLM sees
 * an explicit NO when no cue matched (rather than silence, which it might
 * interpret as missing-data).
 */
const formatSoftnessSection = (softness: SoftnessHint): string => {
  if (!softness.isSoft) {
    return 'Heuristic softness check: SOFT=NO (no light-effort phrasing detected in answers).';
  }
  const cueList = softness.cues.map((c) => `  - ${c}`).join('\n');
  return `Heuristic softness check: SOFT=YES — the learner used phrasing that suggests light-effort intent.\nCues:\n${cueList}`;
};

// ── Depth previews ──────────────────────────────────────

/**
 * `overcommitRisk` is the LLM's holistic judgment of how likely THIS
 * learner is to over-commit if they select a depth above the recommended
 * tier. It supersedes the phrase-regex `isSoft` / `isFinishPressure`
 * signals as the primary input to the depth-override gate — the regex
 * stays only as a fallback for legacy courses persisted before this
 * field existed and as defence-in-depth (whichever signal trips fires
 * the gate).
 *
 * Why a structured field rather than free text: gate logic needs an
 * exact comparison (`risk === 'high'`), not a parse. The rationale is
 * still surfaced verbatim because the dialog and analytics need a
 * citation, but the trigger is the enum.
 */
export const OVERCOMMIT_RISK_LEVELS = ['low', 'moderate', 'high'] as const;
export type OvercommitRisk = (typeof OVERCOMMIT_RISK_LEVELS)[number];

/**
 * `undercommitRisk` is the symmetric companion to `overcommitRisk`. Where
 * overcommit measures the cost-of-completion (will the learner burn out?),
 * undercommit measures the coverage gap (will the picked depth fail to
 * deliver what the learner explicitly asked for?). Drives the new
 * undercommit half of the depth-override gate — fires on a 409 when the
 * learner picks BELOW the recommended tier and the LLM judges the gap is
 * meaningful.
 *
 * Same value semantics as overcommitRisk so the gate logic, dialog
 * rationale plumbing, and metrics counters mirror cleanly.
 */
export const UNDERCOMMIT_RISK_LEVELS = ['low', 'moderate', 'high'] as const;
export type UndercommitRisk = (typeof UNDERCOMMIT_RISK_LEVELS)[number];

const depthPreviewsOutputSchema = z.object({
  overview: z.object({
    summary: z.string(),
    bullets: jsonish(z.array(z.string())),
  }),
  comprehensive: z.object({
    summary: z.string(),
    bullets: jsonish(z.array(z.string())),
  }),
  deep_dive: z.object({
    summary: z.string(),
    bullets: jsonish(z.array(z.string())),
  }),
  recommended: z.enum(COURSE_DEPTHS),
  recommendationReason: z.string(),
  // Best-effort LLM signals — `.optional()` is load-bearing on all four.
  // Haiku occasionally drops these fields under structured-output
  // pressure (especially when the schema grows and the prompt gets
  // longer). Marking them required would invalidate an otherwise-correct
  // depth-previews response and force a retry storm. Instead, missing
  // values fall through to:
  //   - overcommit gate: phrase-regex cost signal (same as legacy)
  //   - undercommit gate: silent pass (no warning — undercommit gating
  //     is opt-in via the LLM signal; we don't have a regex fallback
  //     because deadline/professional-goal phrasing is too varied).
  overcommitRisk: z.enum(OVERCOMMIT_RISK_LEVELS).optional(),
  overcommitRationale: z.string().optional(),
  undercommitRisk: z.enum(UNDERCOMMIT_RISK_LEVELS).optional(),
  undercommitRationale: z.string().optional(),
});

type DepthPreviewsLLMOutput = z.infer<typeof depthPreviewsOutputSchema>;

/**
 * Persisted shape: per-tier preview augmented with deterministic scope
 * ranges (lesson count + estimated hours), computed server-side from the
 * softness signal and the (depth, isSoft) → LESSON_COUNT_HINTS table.
 *
 * The LLM does NOT emit these — they're rule-based and identical for every
 * learner with the same softness signal. Computing here means:
 *   - Cards always show concrete scope, not just bullets ("~18-28 lessons,
 *     ~8-12 hours" lets the learner judge BEFORE clicking, not via a
 *     post-hoc 409 dialog).
 *   - The numbers stay in lockstep with `getLessonCountHint` /
 *     `getEstimatedHoursRange` — change the bands once, both card scope
 *     and gate dialog update together.
 */
type DepthPreviewsOutput = DepthPreviewsLLMOutput & {
  overview: DepthPreviewsLLMOutput['overview'] & {
    lessonCountRange: [number, number];
    estimatedHoursRange: [number, number];
  };
  comprehensive: DepthPreviewsLLMOutput['comprehensive'] & {
    lessonCountRange: [number, number];
    estimatedHoursRange: [number, number];
  };
  deep_dive: DepthPreviewsLLMOutput['deep_dive'] & {
    lessonCountRange: [number, number];
    estimatedHoursRange: [number, number];
  };
};

/**
 * Enrich the LLM output with per-tier `lessonCountRange` and
 * `estimatedHoursRange`. Pure function — same input always gives the same
 * output, so it's deterministic and unit-testable.
 *
 * Soft-band selection: a learner gets the tighter "soft" lesson-count
 * band when EITHER the phrase regex flagged softness OR the LLM emitted
 * `overcommitRisk: 'high'`. This is intentional defence-in-depth — the
 * regex catches only narrow English-formal phrasing while the LLM
 * understands paraphrase. Whichever fires first wins.
 *
 * Legacy courses (persisted before `overcommitRisk` was added) lack the
 * field, in which case `useSoftBand` collapses to the regex signal alone
 * — same behaviour as before this change.
 */
const enrichDepthPreviewsWithScope = (
  llmOutput: DepthPreviewsLLMOutput,
  { isSoft }: { isSoft: boolean },
): DepthPreviewsOutput => {
  const useSoftBand = isSoft || llmOutput.overcommitRisk === 'high';
  const tier = (depth: CourseDepth) => ({
    lessonCountRange: getLessonCountHint({ depth, isSoft: useSoftBand }),
    estimatedHoursRange: getEstimatedHoursRange({ depth, isSoft: useSoftBand }),
  });
  return {
    ...llmOutput,
    overview: { ...llmOutput.overview, ...tier('overview') },
    comprehensive: { ...llmOutput.comprehensive, ...tier('comprehensive') },
    deep_dive: { ...llmOutput.deep_dive, ...tier('deep_dive') },
  };
};

const DEPTH_PREVIEWS_SYSTEM_PROMPT = `You are a world-class curriculum designer. Given a learning goal and the learner's answers to clarifying questions, generate a personalized preview for each of the three course depth levels.

For each depth tier (overview, comprehensive, deep_dive), generate:

1. A "summary" — one sentence describing what THIS learner would achieve at this depth, referencing their specific topic and context. Not generic. Example: "Build a working mental model of Kubernetes architecture and core resources" — not "Get a broad overview of the topic."

2. "bullets" — 3-4 concrete skills or topics covered at this depth. Each bullet should be specific enough that the learner can evaluate whether they need it. Reference their stated experience level, selected focus areas, and goals. Keep each bullet concise (under 15 words).

Rules for depth progression:
- Each level must visibly BUILD on the previous one. Do NOT repeat bullets across levels — each level's bullets cover NEW ground.
- Overview: Key concepts, mental models, foundational understanding. The "I can talk about this intelligently" level.
- Comprehensive: Working knowledge with hands-on application. The "I can do this independently" level. Covers practical skills, real-world techniques, and intermediate patterns beyond overview.
- Deep Dive: Mastery-level coverage. The "I can teach this and handle edge cases" level. Covers advanced patterns, optimization, architecture decisions, and expert-level nuance beyond comprehensive.
- Bullets must reference the learner's specific context. If they mentioned specific tools, interests, or experience, reflect that in the bullets.

Also select a "recommended" depth tier and provide a "recommendationReason" — a single sentence explaining why this depth best fits THIS learner. Reference specific details from their answers (e.g., "Since you already have intermediate Python experience and want to build production APIs, Comprehensive covers the practical depth you need without the theoretical deep dive you didn't ask for.").

Softness handling — read carefully:

The human message may include a "Heuristic softness check" section listing phrases the learner used that suggest light-effort intent (e.g. "just want to learn", "lighter load", "minimal effort", "casual"). When this section says SOFT=YES:
- Default-recommend OVERVIEW. A learner who phrases their goal in low-effort terms is poorly served by being steered into a long course they will not finish.
- Override to Comprehensive only when other answers strongly contradict the softness — for example, a stated deadline that requires deeper coverage, an explicitly-named professional project, or self-reported expert background that needs advanced topics.
- Never override to Deep Dive on a SOFT signal. If you must go beyond Overview, Comprehensive is the ceiling.
- Quote at least one of the detected cues verbatim in \`recommendationReason\` so the learner sees why we trimmed (e.g. "Since you said 'just want to learn more', Overview gets you the mental model without a 30-lesson commitment.").

When SOFT=NO, recommend whichever depth the answers actually call for — do not bias toward Overview.

Also emit two optional fields: \`overcommitRisk\` ("low" | "moderate" | "high") and \`overcommitRationale\` (one short sentence). These rate how likely the learner is to over-commit if they pick a depth ABOVE your recommendation:
- "low" — confident, professionally-driven, or otherwise high-bandwidth answers.
- "moderate" — some hedging, hobbyist framing, or competing commitments.
- "high" — explicit softness, deadline pressure, or commitment uncertainty (paraphrase counts; the regex misses many cases).

The rationale should reference specific answer content (no invented quotes). Skip both fields if you're unsure rather than guessing.

Symmetrically, emit two more optional fields: \`undercommitRisk\` ("low" | "moderate" | "high") and \`undercommitRationale\` (one short sentence). These rate how poorly served the learner will be if they pick a depth BELOW your recommendation — i.e., the COVERAGE-GAP risk, not the cost risk:
- "low" — a lighter tier than recommended would still satisfy the stated goal. Curiosity-driven or exploratory learners often score here.
- "moderate" — a lighter tier would skip practical applications they specifically asked about, but they'd still get useful foundations. Hobbyists with named projects often score here.
- "high" — explicit deadline / exam / interview / professional-grade goal that demands the recommended tier or above. Going below would leave the learner unprepared for what they actually said they need.

Calibration guidance:
- A SOFT=YES learner who picks Overview is almost never undercommitting (their stated goal IS the lighter coverage). Default to "low".
- A learner with a named professional artifact (interview, deadline, project shipping next month) who picks below the recommended tier is almost always at least "moderate", often "high".
- Avoid "high" on both overcommit AND undercommit for the same learner — the recommendation should already split the difference. If you find yourself wanting both, recheck whether the recommendation itself is right.

The undercommit rationale should reference specific answer content (no invented quotes). Skip both undercommit fields if you're unsure rather than guessing — silent fields produce no warning, which is the safer default.`;

// Hand-written tool schema for depth previews. Mirrors `depthPreviewsOutputSchema`
// so the tool_use payload passes Zod validation after parsing. The schema is
// hand-written (not derived from Zod via `z.toJSONSchema`) for two reasons:
//   1. Fewer anyOf wrappers — the LangChain conversion adds noise around the
//      `jsonish()` wrappers on `bullets` arrays which has been correlated with
//      the model collapsing nested structure into strings.
//   2. We control the exact tool contract the model sees, which improves
//      adherence to the per-tier `{ summary, bullets[] }` nesting that has
//      been the regression site (model emitting `overview` as a string with
//      embedded `<parameter name="summary">` XML instead of as an object).
const DEPTH_PREVIEWS_TOOL: Anthropic.Messages.Tool = {
  name: 'depth_previews_output',
  description:
    "Return the three depth-tier previews, the recommended depth + reason, and optional overcommit/undercommit risk signals.",
  input_schema: {
    type: 'object',
    properties: {
      overview: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'bullets'],
      },
      comprehensive: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'bullets'],
      },
      deep_dive: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'bullets'],
      },
      recommended: { type: 'string', enum: [...COURSE_DEPTHS] },
      recommendationReason: { type: 'string' },
      overcommitRisk: { type: 'string', enum: [...OVERCOMMIT_RISK_LEVELS] },
      overcommitRationale: { type: 'string' },
      undercommitRisk: { type: 'string', enum: [...UNDERCOMMIT_RISK_LEVELS] },
      undercommitRationale: { type: 'string' },
    },
    required: ['overview', 'comprehensive', 'deep_dive', 'recommended', 'recommendationReason'],
  },
};

/**
 * Strip Anthropic tool-use XML residue (`<parameter name="X">value</parameter>`)
 * that occasionally bleeds into structured-output payloads when the model
 * conflates JSON nesting with internal tool-call syntax. Recursively walks
 * every string in the value; arrays/objects/nullish pass through. Idempotent
 * on clean input.
 *
 * The tool_use contract should make this leak rare in practice — we still
 * sanitize defensively because the failure mode it guards against (a
 * `Failed to parse` storm that exhausts retries and aborts the persona
 * run) is more expensive than the regex pass.
 */
const stripXmlParameterTags = (input: unknown): unknown => {
  if (typeof input === 'string') {
    return input.replace(/<\/?parameter\b[^>]*>/g, '').trim();
  }
  if (Array.isArray(input)) return input.map(stripXmlParameterTags);
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = stripXmlParameterTags(v);
    }
    return out;
  }
  return input;
};

interface DepthPreviewsInput {
  goal: string;
  answers: { questionId: string; answer: string }[];
}

export const generateDepthPreviews = async (params: DepthPreviewsInput): Promise<DepthPreviewsOutput> => {
  const goal = sanitizePromptInput(params.goal);
  const softness = detectSoftnessHint({ answers: params.answers });

  const humanMessage = `Learning goal: ${goal}

Learner's answers to clarifying questions:
${formatAnswers(params.answers)}

${formatSoftnessSection(softness)}

Generate personalized depth previews for each tier.`;

  // Migrated from LangChain `withStructuredOutput` → raw Anthropic SDK +
  // explicit tool_use after a recurring "Failed to parse" regression where
  // the model leaked tool-use-style XML (`<parameter name="summary">...</parameter>`)
  // into the JSON output, collapsing `overview` from an object into a
  // string. The hand-written `input_schema` above is a stronger contract
  // for the model than the LangChain-converted Zod schema, and we own the
  // parse step (sanitize + Zod) so a future leak surfaces as a clean
  // retry rather than an unrecoverable parse failure.
  //
  // Model: SONNET. Previously HAIKU; swapped after a recurring structural
  // collapse failure mode where, on sprawling inputs ("learn everything
  // about app development — iOS, Android, backend, databases, APIs, UI"),
  // Haiku emitted a partial payload containing only `overview` and dropped
  // the `comprehensive` / `deep_dive` / `recommended` / `recommendationReason`
  // fields entirely, exhausting all retries with the same shape. Sonnet
  // holds nested structured output through cognitively-heavy inputs much
  // better. Depth-previews is once-per-course and well below the volume
  // of structure / lesson-content generation, so the cost delta is
  // negligible vs. the loss of a whole course-creation flow.
  //
  // Retry label `clarify:depth-previews` keeps the `with_retry_total{label=...}`
  // dashboard slice intact so retry rates remain comparable across the
  // refactor.
  const response = await withRetry(
    async () => {
      const result = await withCallTimeout((signal) => anthropic.messages.create({
        model: MODEL_IDS.SONNET,
        max_tokens: 4096,
        temperature: 0.7,
        system: [
          {
            type: 'text',
            text: DEPTH_PREVIEWS_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: humanMessage }],
        tools: [DEPTH_PREVIEWS_TOOL],
        tool_choice: { type: 'tool', name: DEPTH_PREVIEWS_TOOL.name },
      }, { signal }));

      logCacheUsage({
        label: 'clarify:depth-previews',
        usage: usageFromAnthropic(result),
        model: MODEL_IDS.SONNET,
      });

      const toolUse = result.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );
      if (!toolUse) {
        throw new Error('depth-previews: model did not emit a tool_use block');
      }
      // Defense-in-depth: strip any `<parameter ...>` XML residue before
      // Zod validates the shape. If the leak is subtler than this regex
      // catches (e.g., the model emits a string-where-an-object-belongs),
      // Zod will throw and `withRetry` will re-invoke.
      const sanitized = stripXmlParameterTags(toolUse.input);
      return depthPreviewsOutputSchema.parse(sanitized);
    },
    { label: 'clarify:depth-previews' },
  );

  return enrichDepthPreviewsWithScope(response, { isSoft: softness.isSoft });
};

/**
 * Read-time backfill for `course.depthPreviews`. Existing courses persisted
 * before per-tier `lessonCountRange` / `estimatedHoursRange` were added are
 * still in the DB without those fields; without a backfill, returning
 * learners would see no scope on their cards. This helper:
 *
 *   1. Returns the input unchanged if `depthPreviews` is null OR if the
 *      first tier already carries scope (idempotent — write-time
 *      enrichment is a no-op on a second pass).
 *   2. Otherwise, recomputes the softness signal from `answers` and
 *      runs the same `enrichDepthPreviewsWithScope` augmentation, so the
 *      numbers a returning learner sees are identical to what a brand-new
 *      learner with the same answers would see.
 *
 * Defensive: if `depthPreviews` is malformed (e.g. missing one of the
 * three tiers), we leave it alone — a half-enriched object would break
 * client rendering, and bad shapes are extremely unlikely in practice
 * because the Zod schema gates the write.
 */
export const ensureDepthPreviewsScope = <T extends { answers?: unknown; depthPreviews?: unknown }>(
  course: T,
): T => {
  const dp = course.depthPreviews as
    | (DepthPreviewsLLMOutput & { overview?: { lessonCountRange?: unknown } })
    | null
    | undefined;
  if (!dp) return course;
  if (dp.overview?.lessonCountRange) return course;
  if (!dp.overview || !dp.comprehensive || !dp.deep_dive) return course;

  const answersRecord = (course.answers ?? null) as Record<string, unknown> | null;
  const formattedAnswers = answersRecord
    ? Object.entries(answersRecord).map(([id, a]) => ({
        questionId: id,
        answer: Array.isArray(a) ? a.join(', ') : String(a),
      }))
    : [];
  const softness = detectSoftnessHint({ answers: formattedAnswers });
  const enriched = enrichDepthPreviewsWithScope(dp as DepthPreviewsLLMOutput, { isSoft: softness.isSoft });
  return { ...course, depthPreviews: enriched };
};

// ── Generate course structure ───────────────────────────

const structureOutputSchema = z.object({
  courseName: z.string(),
  domain: z.enum(COURSE_DOMAINS),
  reasoning: z.object({
    learnerProfile: z.string(),
    topicAnalysis: z.string(),
    scopeDecisions: z.string(),
    progressionStrategy: z.string(),
  }),
  modules: jsonish(z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      lessons: jsonish(z.array(
        z.object({
          name: z.string(),
          description: z.string(),
        }),
      )),
    }),
  )),
});

type StructureOutput = z.infer<typeof structureOutputSchema>;

// ── Per-domain classifier guidance ─────────────────────
// The structure-design prompt asks the LLM to classify each course into
// one of COURSE_DOMAINS. The map below both documents the scope of each
// domain (for the LLM to read) and enforces a compile-time check: adding
// a value to COURSE_DOMAINS without an entry here fails `tsc`. That's the
// primary guarantee we want — the classifier can never silently default
// to "other" for a new domain because the enum grew without the prompt
// being updated.

const STRUCTURE_DOMAIN_GUIDANCE: Record<CourseDomain, string> = {
  programming: 'software engineering, systems, web, devops, data engineering, security, data science with code (pandas, NumPy, scikit-learn, PyTorch, TensorFlow), MLOps, computational X with code — any course whose primary activity is WRITING AND READING SOURCE CODE. Choose this even when the underlying subject is math-heavy (statistics, ML, physics simulations) as long as the learner\'s day-to-day is in code. "Linear regression in scikit-learn" is programming; "Linear regression: least-squares derivation" is stem.',
  stem: 'mathematics, physics, chemistry, biology, statistics, engineering, economics, quantitative finance — disciplines whose content lives on equations, formulas, and quantitative reasoning. Choose this ONLY when the learner\'s primary activity is thinking with symbols and numbers — solving problems on paper, deriving, proving, computing by hand or with a calculator. If the learner will spend most of their time WRITING CODE (even to apply math), prefer `programming`.',
  humanities: 'history, philosophy, literature, law, social sciences, religion.',
  language: 'natural-language learning (Spanish, Mandarin, ASL, etc.) — acquiring a language as a non-native speaker. NOT communication skills in the learner\'s own language (that is life-skills).',
  creative: 'visual art, music, writing craft, design, photography, performance — production-oriented courses where the learner MAKES something in a medium.',
  business: 'management, marketing, product management, sales, strategy, negotiation, personal finance, entrepreneurship, operations, and economics applied to real-world decisions. Includes Agile/Scrum, leadership, and applied econ/finance.',
  practical: 'hands-on physical skills — cooking, baking, home repair, gardening, trades (plumbing, carpentry, electrical), crafts, fitness and training routines, outdoor skills. Courses where practice requires tools, materials, or physical action in a real environment.',
  'practical-ai': 'operating AI tools and writing prompts as the primary skill — prompt engineering, no-code/low-code AI workflows (n8n, Zapier, Make), agent recipes (custom GPTs, Claude Projects, LangChain/LangGraph used as a configuration surface), RAG and chatbot assembly via off-the-shelf platforms, AI for marketing/sales/research/ops AS TOOL USE, and creative-AI tooling (Midjourney, Runway, Suno, ElevenLabs) when the lesson is about prompt craft and tool operation rather than artistic intent. Choose this when the learner\'s primary activity is OPERATING A TOOL OR CRAFTING A PROMPT, not WRITING SOFTWARE WITH AI LIBRARIES — that is `programming`. Domain-of-application (marketing, customer support, recruiting) does NOT override: an AI workflow course wins over `business`/`practical`/`creative` when the lesson-level content is about model choice, prompt shape, tool wiring, eval, and failure modes.',
  'life-skills': 'personal effectiveness and communication in the learner\'s own language — public speaking, interpersonal communication, productivity systems, career development, habit-building, emotional intelligence, soft skills. Distinct from creative writing (which is creative) and from language acquisition (which is language).',
  other: "anything that genuinely doesn't fit any of the categories above. Rare after the introduction of business, practical, and life-skills — before picking this, re-check whether the course actually fits one of those three.",
};

const STRUCTURE_DOMAIN_BULLETS = COURSE_DOMAINS
  .map((d) => `- "${d}": ${STRUCTURE_DOMAIN_GUIDANCE[d]}`)
  .join('\n');

const STRUCTURE_SYSTEM_PROMPT = `You are a world-class curriculum designer, subject matter expert, and learning scientist. You design personalized courses that respect each learner's existing knowledge, align with their goals, and progress through increasing cognitive complexity.

Your task: Design a structured course as a linear sequence of modules, each containing ordered lessons. The course must be deeply personalized — not a generic template with the learner's topic inserted.

First, generate a concise, descriptive course title as the courseName field (2-6 words). The title should reflect both the topic and the learner's specific focus — "Kubernetes for Data Engineers" not just "Learn Kubernetes." Make it specific and professional.

Next, classify the course into ONE primary domain (the \`domain\` field). This classification steers downstream lesson generation (block-type mix, math-vs-code balance, example style):
${STRUCTURE_DOMAIN_BULLETS}
Pick the SINGLE best fit. When a course spans domains (e.g., computational physics), pick the domain that best describes the lesson-level content the learner will read.

Classify by the SUBJECT MATTER the learner will actually study, not by the action verb in their goal. Pedagogy-of-X keeps X's domain: "teaching creative writing to high schoolers" is \`creative\` (the subject IS creative writing); "learning to teach biology" is \`stem\` (the subject is biology).

Programming-vs-stem disambiguator — use the PRIMARY-ACTIVITY test:
- If the learner will spend the majority of their study time WRITING CODE — implementing algorithms, building pipelines, training models, fitting APIs — tag \`programming\` regardless of the mathematical content.
- If the learner will spend the majority of their study time REASONING WITH SYMBOLS — deriving, proving, solving problems on paper, working through formulas — tag \`stem\`.
- Worked examples:
  - "Data science with pandas/SQL/scikit-learn, building classifiers in Python" → \`programming\`.
  - "Deep learning from scratch: backprop math, optimization theory, without code" → \`stem\`.
  - "MLOps: deploying PyTorch models with Docker + FastAPI" → \`programming\`.
  - "Statistical mechanics: partition functions and ensembles" → \`stem\`.
  - "Computational physics: simulating the n-body problem in NumPy" → \`programming\` (primary activity is code).
  - "Bioinformatics with Biopython" → \`programming\` (code-first application of bio).
  - "Molecular biology: central dogma, transcription regulation" → \`stem\` (no code).
  - "Blockchain with Solidity" is \`programming\` (code-heavy); "the math behind zero-knowledge proofs" is \`stem\`.

Practical-AI-vs-neighbors disambiguator — apply the primary-activity test:
- "n8n agent for inbound lead-gen" → \`practical-ai\` (no-code wiring, prompts).
- "Build a RAG chatbot in Python with LangChain + pgvector" → \`programming\` (writing software).
- "Prompt library for cold outreach as a B2B SDR" → \`practical-ai\` (prompt craft is the skill).
- "Sales playbook for outbound at a Series B SaaS" → \`business\` (no AI tool operation at the core).
- "Midjourney for product photography" → \`practical-ai\` (lesson-level content is prompts, parameters, upscaling workflow).
- "Composition and lighting for product photography" → \`creative\` (medium craft, gear-independent).
- "Fine-tune a Llama model on customer support tickets" → \`programming\` (training-loop code, infra).
- "ChatGPT for ad copy as a solo marketer" → \`practical-ai\` (prompt patterns + tool operation, not marketing strategy).

"Business writing" is \`business\` (the aim is business communication); "writing short fiction" is \`creative\`. Before defaulting to \`other\`, re-read the \`business\`, \`practical\`, and \`life-skills\` scopes — most non-STEM/non-code courses fit one of those three.

CRITICAL — Before generating any modules, you MUST fill in the reasoning fields. Think carefully:

1. learnerProfile: Synthesize who this learner is from their answers. What do they already know? What are their blind spots? What motivates them? What constraints do they have? Be specific — "A beginner interested in web development for a career change" not "A learner who wants to learn programming."

2. topicAnalysis: What are the core concepts, prerequisite chains, and common pitfalls in this domain? What do experts know that beginners don't realize they need? What are the critical "unlock" concepts that enable everything else?

3. scopeDecisions: Based on the learner's profile and the depth tier, what SPECIFICALLY should be included and excluded? This is where personalization happens. If the learner is experienced, state exactly which foundational topics are being skipped and why. If they selected specific focus areas, those should dominate — state how much weight each gets. If they have a specific project, the curriculum should build toward it.

4. progressionStrategy: How should cognitive difficulty build across this specific curriculum? Map the progression through Bloom's taxonomy:
   - Early modules: Remember & Understand (definitions, concepts, mental models)
   - Middle modules: Apply & Analyze (hands-on practice, problem-solving, pattern recognition)
   - Later modules: Evaluate & Create (independent judgment, original work, integration of concepts)
   State where the transitions happen for THIS curriculum.

Course depth — scope guidance:
- "overview": A short course. A few modules covering key concepts and mental models only. No deep practice.
- "comprehensive": A thorough course. Multiple modules covering the topic with solid working knowledge and application. The bulk of the course should be at the Apply/Analyze level.
- "deep_dive": An extensive, mastery-level course. Many modules covering the topic from foundations (or wherever the learner starts) through to advanced material. Let the topic's natural complexity determine the right number of modules and lessons within the cap below.

Total-lesson scope cap (mandatory) — the human message includes a "Lesson-count target" line stating a (min, max) range for the total lesson count summed across all modules. This range is derived from the chosen depth and the heuristic softness signal:
- Generate a course whose TOTAL lesson count (sum across all modules) falls within the stated range. The max is a hard ceiling for normal cases — going over it requires the topic to genuinely need more (e.g., a multi-language programming course where each language is itself a sub-course).
- When the softness signal is SOFT=YES, treat the LOW end of the range as the default and only push toward the middle when the answers genuinely require more breadth. Never go above the range on a SOFT=YES learner — they explicitly signalled they will not finish a long course.
- If you trim the course to fit a SOFT cap, name what you trimmed in \`scopeDecisions\`. For example: "Because the learner said 'just want to learn more', advanced modules on X and Y are deferred — the course covers the 18 highest-leverage lessons."
- The total lesson count is the sum across modules. If you produce 6 modules with 5 lessons each, that's 30 lessons total — make sure the sum sits within the cap, not just any individual module.

Rules for module and lesson design:
- If the learner reported intermediate or advanced experience, DO NOT include introductory or foundational modules. Start where their knowledge ends.
- If the learner selected specific focus areas (via multiple-select answers), those areas should comprise the majority of the curriculum. Don't dilute focus with tangential topics.
- Every module and lesson name must be specific to the topic. NEVER use generic names like "Advanced Topics", "Best Practices", "Getting Started", or "Key Concepts" — these tell the learner nothing. Use names that describe concrete outcomes: "Building a CI/CD Pipeline with GitHub Actions" not "DevOps Best Practices".
- Each module description should explain what the learner will be able to DO after completing it, not just what they'll "learn about".
- Each lesson description should be specific enough that the learner can preview whether they already know this material.
- Early modules should have slightly fewer, simpler lessons. Lesson count and complexity should increase as the course progresses — this respects cognitive load.
- The final module should integrate and synthesize — not just "more topics". It should pull together everything into a capstone-level challenge or project.

When the learner supplied free-text answers in \`answers[]\`, treat their exact phrasing as a contract. If they named a concrete concept, tool, stakeholder, audience, project, framework, or constraint, surface that wording in your reasoning and let it shape the curriculum. If they said "RLHF", the course mentions RLHF by name; if they said "I'm teaching middle-schoolers", the examples and framing target middle-schoolers; if they named a specific codebase or dataset, the curriculum builds toward it. Quote at least one such phrase verbatim in \`learnerProfile\` or \`scopeDecisions\` whenever a free-text answer is present — do not paraphrase away the specificity.

Thin-answer handling: a text answer may be tagged with the marker \`[thin answer — weak signal]\`. This means the learner replied with ≤3 tokens (e.g., "stop overspending" or "analyzing customer data") — enough to hint at their intent but NOT enough to support confident scope decisions. When you see this marker:
- Do not invent specifics the learner did not supply (don't infer "stop overspending" means "they have specifically $X in credit card debt at Y rate"). Acknowledge the intent in \`learnerProfile\` and leave specifics open.
- Prefer broader, reversible scope decisions over narrow, highly-tailored ones. If they said "stop overspending", design the course around general overspending mechanisms — not a debt-payoff calculator track the learner never asked for.
- Note the thinness explicitly in \`scopeDecisions\` (e.g., "Learner gave a brief 'stop overspending' goal — curriculum covers the core diagnostic and budgeting patterns without over-specializing to a particular debt type the learner did not name.").

Within the lesson-count cap, let the topic and the learner's needs determine the right scope — do not pad with filler lessons. Every lesson should earn its place.`;

interface StructureInput {
  goal: string;
  answers: { questionId: string; answer: string }[];
  depth: CourseDepth;
  // Pre-classified during the clarify job (and overridable by the user via
  // the ClarifyStep chip). Defaults to `master` for pre-feature courses
  // re-entering the structure pipeline — the `master` branch in the
  // structure prompt is explicitly the no-op path.
  goalType: GoalType;
}

// How `goalType` reshapes the curriculum. Single source of truth — one
// sentence per type, surfaced in the structure prompt's human message so
// it's part of the request, not the cached system prompt (the rules vary
// per course; the overall framework belongs in the system prompt).
const GOAL_TYPE_STRUCTURE_GUIDANCE: Record<GoalType, string> = {
  master:
    'Default behavior — comprehensive ladder, foundations included unless the learner reported intermediate or advanced experience. No special structural constraint.',
  monetize:
    "Every module must end in a TACTICAL ACTION lesson the learner can execute the same week (\"Run your first 3-day Meta ad test\", \"Publish your channel-trailer reel\"). Quote the learner's named PRODUCT, NICHE, AUDIENCE, or CHANNEL verbatim in module names — no generic \"fundamentals of X\" titles. Defer abstract theory in favor of playbook-style content. The capstone module ships a public, revenue-relevant artifact (a launched campaign, a posted content series, a closed first sale).",
  pass:
    "Modules must map to the exam's SYLLABUS sections (use the official syllabus structure when known — CPA's four sections, JEE's Physics/Chem/Math, BITSAT's PCM-E). Lessons within each module include retrieval-practice quizzes early and past-paper-style problems often. The FINAL MODULE must be a timed mock exam under realistic conditions plus a weak-topic retarget pass. If the learner's goal text mentions a date or deadline (\"by October\", \"BITSAT 2025\"), note it explicitly in `scopeDecisions` and trim toward the LOW end of the lesson-count target — the cap matters more than depth here.",
  build:
    "The course is a project SPINE. Module 1 always sets up the project (skeleton repo, dev env, the simplest version that runs). Each subsequent module ships a CHECKPOINT — a feature that builds on the previous module and is testable on its own. The CAPSTONE is polish + deploy (or equivalent for non-software builds). No \"theory only\" modules — every concept enters the curriculum at the moment the project needs it.",
  fluency:
    "Progressive exposure with retrieval emphasis. Modules organize around CONVERSATIONAL DOMAINS (greetings + small talk, ordering food, asking for directions, work/study scenarios) when the target is conversational fluency, or around SKILL TRACKS (listening, speaking, reading, writing) when the target is broader. Lessons emphasize active recall over passive reading. (Block-type tuning — vocab cards, cloze, listening prompts — is deferred to lesson generation.)",
};

const formatGoalTypeStructureSection = (goalType: GoalType): string =>
  `Goal type: ${goalType}\nGoal-type curriculum guidance: ${GOAL_TYPE_STRUCTURE_GUIDANCE[goalType]}`;

/** Count total lessons across all modules in a generated structure. */
const totalLessonCount = (structure: StructureOutput): number =>
  structure.modules.reduce((sum, m) => sum + m.lessons.length, 0);

export const generateCourseStructure = async (params: StructureInput): Promise<StructureOutput> => {
  const { answers, depth, goalType } = params;
  const goal = sanitizePromptInput(params.goal);
  const softness = detectSoftnessHint({ answers });
  const [capMin, capMax] = getLessonCountHint({ depth, isSoft: softness.isSoft });
  const model = getStructureModel();
  const structuredModel = model.withStructuredOutput(structureOutputSchema);

  const humanMessage = `Learning goal: ${goal}

Learner's answers to clarifying questions:
${formatAnswers(answers)}

Chosen course depth: ${depth}

${formatSoftnessSection(softness)}

${formatGoalTypeStructureSection(goalType)}

Lesson-count target: ${capMin}-${capMax} total lessons (sum across all modules). Do not exceed ${capMax} unless the topic genuinely cannot be taught at this scale.

Fill in the reasoning fields first, then design the course structure.`;

  const response = await withRetry(() =>
    withCallTimeout((signal) =>
      structuredModel.invoke(
        [cachedSystemMessage({ text: STRUCTURE_SYSTEM_PROMPT }), new HumanMessage(humanMessage)],
        { metadata: { llmLabel: 'structure:generate' }, signal },
      ),
    ),
  );

  // Observation-only post-check. The cap is a pedagogical suggestion the
  // prompt carries — not a correctness invariant. Previous iteration of
  // this function tried a corrective-regeneration + hard-throw, but that
  // cost ~2 min of Sonnet time and failed entire courses on misses. A
  // 32-lesson comprehensive course is verbose but usable; a failed Step 6
  // is not. Per user directive: "range is only a suggestion, should not
  // be a hard rule". We warn + emit a counter so dashboards can observe
  // the LLM's miss rate, but we always return what the LLM produced.
  const lessonCount = totalLessonCount(response);
  if (lessonCount > capMax) {
    bumpStructureCapExceeded();
    genLog.warn(
      `course:structure cap-exceeded lessons=${lessonCount} cap=${capMax} depth=${depth} soft=${softness.isSoft} — accepted (cap is advisory)`,
    );
  }

  return response;
};

// ── Refine course structure ─────────────────────────────

interface RefineInput extends StructureInput {
  currentStructure: {
    modules: { name: string; description: string; lessons: { name: string; description: string }[] }[];
  };
  currentDomain?: CourseDomain | null;
  feedback: string;
  feedbackHistory: string[];
}

export const refineCourseStructure = async (params: RefineInput): Promise<StructureOutput> => {
  const { answers, depth, goalType, currentStructure, currentDomain } = params;
  const goal = sanitizePromptInput(params.goal);
  const feedback = sanitizePromptInput(params.feedback);
  const feedbackHistory = params.feedbackHistory.map(sanitizePromptInput);
  const softness = detectSoftnessHint({ answers });
  const [capMin, capMax] = getLessonCountHint({ depth, isSoft: softness.isSoft });
  const model = getStructureModel();
  const structuredModel = model.withStructuredOutput(structureOutputSchema);

  const currentStructureText = currentStructure.modules
    .map(
      (m, i) =>
        `Module ${i + 1}: ${m.name}\n  ${m.description}\n  Lessons:\n${m.lessons.map((l, j) => `    ${j + 1}. ${l.name} — ${l.description}`).join('\n')}`,
    )
    .join('\n\n');

  const humanMessage = `Learning goal: ${goal}

Learner's answers to clarifying questions:
${formatAnswers(answers)}

Chosen course depth: ${depth}

${formatSoftnessSection(softness)}

${formatGoalTypeStructureSection(goalType)}

Lesson-count target: ${capMin}-${capMax} total lessons (sum across all modules). The current structure may be inside or outside this range; respect the cap unless the learner's CURRENT REQUEST below explicitly asks to expand beyond it.

${currentDomain ? `Current course domain: ${currentDomain} — keep this domain unless the refinement genuinely changes the subject of the course.\n\n` : ''}--- CURRENT STRUCTURE (previously generated) ---
${currentStructureText}

${feedbackHistory.length > 0 ? `--- PREVIOUS REFINEMENTS (already applied to the structure above) ---\n${feedbackHistory.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n` : ''}--- CURRENT REQUEST ---
${feedback}

The learner has reviewed the structure above and wants changes. Modify the structure to address their current request.

Rules for refinement:
- PRESERVE modules and lessons the learner did not mention — do not reorganize or rename things that are working.
- Only change what the current request specifically asks for.
- The previous refinements listed above have ALREADY been applied to the current structure. Do not undo them unless the current request explicitly asks to reverse a previous change.
- If the feedback asks to remove, add, merge, or split modules/lessons, do exactly that.
- Maintain pedagogical quality, Bloom's taxonomy progression, and specific lesson naming standards.
- Consider whether additions are appropriate for the learner's experience level and the chosen depth tier. If adding content would push the course beyond the lesson-count target above, prefer a focused addition over an expansive one — unless the learner's current request explicitly asks to grow the course.
- Update the reasoning fields to reflect the refined structure.
- The result should feel like a thoughtful revision, not a complete regeneration.`;

  const response = await withRetry(() =>
    withCallTimeout((signal) =>
      structuredModel.invoke(
        [cachedSystemMessage({ text: STRUCTURE_SYSTEM_PROMPT }), new HumanMessage(humanMessage)],
        { metadata: { llmLabel: 'structure:refine' }, signal },
      ),
    ),
  );

  return response;
};
