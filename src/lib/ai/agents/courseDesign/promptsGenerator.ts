import { HumanMessage } from '@langchain/core/messages';
import { getUtilityModel } from '@lib/langchain';
import { chatLog } from '@lib/loggers';
import CourseModel from '@models/CourseModel';

/**
 * One-shot Haiku call that produces 3-4 design-chat opening prompts for the
 * structure-review screen's empty state. Run once per structure generation
 * (and re-run after each `modify_structure`) and cached on
 * `Course.suggestedDesignPrompts`.
 *
 * Mirrors `generateMentorPrompts` in `lessonMentor/promptsGenerator.ts` —
 * same null-on-failure contract, same truncation discipline, same caller
 * fallback path. The differences are:
 *   - Anchored to the COURSE goal + structure (not a single lesson)
 *   - Aware of the depth-recommendation context (overcommit/undercommit
 *     rationale) so prompts can surface depth-mismatch concerns the
 *     learner might want to act on
 *   - Capped at 4 prompts (one more than the lesson generator) so we can
 *     fit one structural, one persona-anchored, one trim/expand, and one
 *     pedagogical question without overflowing the empty-state UI.
 *
 * Returns null on:
 *   - LLM call failure (network, timeout)
 *   - malformed JSON / wrong shape
 *   - empty array
 *
 * Caller MUST treat null as "fall back to hardcoded prompts" — never as
 * a hard failure. Lesson + course generation must continue regardless.
 */

const SYSTEM_INSTRUCTIONS = `You generate up to 4 brief opening prompts a learner can pick to start chatting with the AI design mentor for THIS specific course they're reviewing.

Requirements:
- Each prompt is 6-14 words. No more.
- Each prompt is specific to THIS course's goal and structure. Generic prompts ("Add more content", "Make it harder") are forbidden.
- Phrased from the learner's perspective: "Should I…", "Why is…", "Can we…", "How does…", "What about…".
- The set of 3-4 prompts should mix these flavors:
  1. STRUCTURAL / pedagogical: "Why is Module 3 placed before Module 4?", "How do these modules build on each other?"
  2. PERSONA-ANCHORED to the goal: e.g. for a "Python for ML" goal — "Show me what's in the data-science module"
  3. TRIM-or-EXPAND when the depth context shows overcommit or undercommit risk:
     - If overcommitRationale present → one prompt invites trimming (e.g. "Can we trim this — I have 2 weeks total")
     - If undercommitRationale present → one prompt invites expansion of the specific gap mentioned
     - If neither → SKIP this slot (prefer 3 strong prompts over 4 weak ones)
  4. CONCRETE-CHANGE seed: "Add a module on X", "Replace [topic] with something more practical"
- Reference module names, lesson topics, or the goal verbatim where useful.
- Plain language. No jargon the learner hasn't seen.
- AVOID duplicating these existing hardcoded fallbacks: "Why this module order?", "Add more practical exercises", "Skip the basics, I know them".

Return ONLY valid JSON in this exact shape, with no markdown fences or commentary:
{ "prompts": ["prompt 1", "prompt 2", "prompt 3"] }

Or up to 4 entries when the depth context warrants the trim/expand prompt.`;

const MAX_STRUCTURE_CHARS = 6_000;
const MAX_PROMPT_CHARS = 200;
const MAX_PROMPT_COUNT = 4;

interface PromptGenerationInput {
  goal: string;
  selectedDepth: string;
  recommendedDepth?: string;
  /** Selected-tier scope range, for context. */
  selectedLessonCountRange?: [number, number];
  /** Recommended-tier scope range, for "what you'd get instead" framing. */
  recommendedLessonCountRange?: [number, number];
  overcommitRationale?: string;
  undercommitRationale?: string;
  answers: { questionId: string; answer: string }[];
  structure: {
    modules: { name: string; description: string; lessons: { name: string; description: string }[] }[];
  };
}

const tryParsePrompts = (raw: string): string[] | null => {
  // Strip any accidental markdown fence the model might have added
  // (despite explicit instructions). Match a leading ```json ... ```
  // block; otherwise parse as-is.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const promptsField = (parsed as { prompts?: unknown }).prompts;
  if (!Array.isArray(promptsField)) return null;

  // Hard-trim to MAX_PROMPT_COUNT, drop non-strings + empty strings,
  // enforce length cap.
  const prompts = promptsField
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.length <= MAX_PROMPT_CHARS)
    .slice(0, MAX_PROMPT_COUNT);

  return prompts.length > 0 ? prompts : null;
};

const summarizeStructure = (
  structure: PromptGenerationInput['structure'],
): string => {
  // Compact rendering — module names + lesson names, no descriptions, so
  // the prompt-gen Haiku has the shape of the course without the cost
  // of every description string. Truncated as a final safety net.
  const lines = structure.modules.map((m, i) => {
    const lessons = m.lessons.map((l, j) => `   ${j + 1}. ${l.name}`).join('\n');
    return `Module ${i + 1}: ${m.name}\n${lessons}`;
  });
  const joined = lines.join('\n\n');
  return joined.length > MAX_STRUCTURE_CHARS
    ? `${joined.slice(0, MAX_STRUCTURE_CHARS)}\n... (truncated)`
    : joined;
};

const summarizeAnswers = (
  answers: PromptGenerationInput['answers'],
): string => {
  if (!answers.length) return '(no clarify answers)';
  return answers.map((a) => `- ${a.questionId}: ${a.answer}`).join('\n');
};

const formatRange = (range: [number, number] | undefined): string =>
  range ? `${range[0]}–${range[1]}` : 'unknown';

export const generateDesignPrompts = async ({
  goal,
  selectedDepth,
  recommendedDepth,
  selectedLessonCountRange,
  recommendedLessonCountRange,
  overcommitRationale,
  undercommitRationale,
  answers,
  structure,
}: PromptGenerationInput): Promise<string[] | null> => {
  const structureSummary = summarizeStructure(structure);
  const answersSummary = summarizeAnswers(answers);

  // Only render the depth-context block when there's something meaningful
  // to render. Keeps the prompt focused for the common Match case where
  // the trim/expand slot doesn't apply.
  const hasDepthContext =
    !!recommendedDepth ||
    !!overcommitRationale ||
    !!undercommitRationale;
  const depthBlock = hasDepthContext
    ? `

## Depth Recommendation Context
- Selected depth: ${selectedDepth} (${formatRange(selectedLessonCountRange)} lessons)
- Recommended depth: ${recommendedDepth ?? 'N/A'} (${formatRange(recommendedLessonCountRange)} lessons)
- Match: ${selectedDepth === recommendedDepth ? 'yes' : 'no'}${overcommitRationale ? `\n- Overcommit rationale: ${overcommitRationale}` : ''}${undercommitRationale ? `\n- Undercommit rationale: ${undercommitRationale}` : ''}`
    : '';

  const userPrompt = `${SYSTEM_INSTRUCTIONS}

## Course goal
${goal || '(none provided)'}

## Learner clarify answers
${answersSummary}

## Course structure
${structureSummary}${depthBlock}`;

  try {
    const model = getUtilityModel();
    const result = await model.invoke([new HumanMessage(userPrompt)], {
      metadata: { llmLabel: 'design:generate-prompts' },
    });

    const content =
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    const prompts = tryParsePrompts(content);
    if (!prompts) {
      chatLog.warn(`design:prompts malformed-response raw="${content.slice(0, 200)}"`);
      return null;
    }

    chatLog.info(`design:prompts ok count=${prompts.length} goal="${goal.slice(0, 60)}"`);
    return prompts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    chatLog.warn(`design:prompts fail reason=${message}`);
    return null;
  }
};

/**
 * Persistence wrapper: load the course, call `generateDesignPrompts` from
 * its current state, and write the result to `course.suggestedDesignPrompts`.
 *
 * Designed to be safe to call from multiple call sites (the structure-job
 * completion in jobRunner, and the modify_structure tool in the design
 * agent's tool flow). Both should be fire-and-forget from the caller's
 * perspective: errors are caught + logged here, never propagated, so a
 * Haiku hiccup never fails the parent operation.
 *
 * Returns the persisted prompts on success, or `null` on any failure
 * path (course missing, no structure yet, generation failed, persist
 * failed). Callers shouldn't branch on the return value — it's
 * informational only.
 */
export const regenerateAndPersistDesignPrompts = async (
  courseId: string,
): Promise<string[] | null> => {
  try {
    const course = await CourseModel.findById(courseId).lean();
    if (!course) {
      chatLog.warn(`design:prompts skip course-not-found course=${courseId}`);
      return null;
    }
    if (!course.structure || !course.structure.modules?.length) {
      // Structure not yet generated (or was wiped). Nothing meaningful to
      // anchor prompts to. Persist empty so the client falls back to the
      // hardcoded defaults — same as a legacy course.
      chatLog.info(`design:prompts skip no-structure course=${courseId}`);
      return null;
    }

    const previews = course.depthPreviews as Record<string, unknown> | null;
    const recommendedDepth =
      typeof previews?.recommended === 'string' ? (previews.recommended as string) : undefined;
    const recommendedTier =
      recommendedDepth && previews && typeof previews[recommendedDepth] === 'object'
        ? (previews[recommendedDepth] as Record<string, unknown>)
        : undefined;
    const selectedTier =
      course.depth && previews && typeof previews[course.depth] === 'object'
        ? (previews[course.depth] as Record<string, unknown>)
        : undefined;
    const readRange = (v: unknown): [number, number] | undefined => {
      if (!Array.isArray(v) || v.length !== 2) return undefined;
      const [a, b] = v;
      return typeof a === 'number' && typeof b === 'number' ? [a, b] : undefined;
    };

    // The persisted answers shape is `Record<string, unknown>`; flatten
    // into the `{ questionId, answer }[]` shape the generator expects.
    // Mirrors `formatAnswersForSoftness` in updateCourse.ts.
    const answers = course.answers
      ? Object.entries(course.answers).map(([id, a]) => ({
          questionId: id,
          answer: Array.isArray(a) ? a.join(', ') : String(a),
        }))
      : [];

    const prompts = await generateDesignPrompts({
      goal: course.goal,
      selectedDepth: course.depth ?? 'comprehensive',
      recommendedDepth,
      selectedLessonCountRange: readRange(selectedTier?.lessonCountRange),
      recommendedLessonCountRange: readRange(recommendedTier?.lessonCountRange),
      overcommitRationale:
        typeof previews?.overcommitRationale === 'string'
          ? (previews.overcommitRationale as string)
          : undefined,
      undercommitRationale:
        typeof previews?.undercommitRationale === 'string'
          ? (previews.undercommitRationale as string)
          : undefined,
      answers,
      structure: course.structure as {
        modules: { name: string; description: string; lessons: { name: string; description: string }[] }[];
      },
    });

    // Always write — even an empty array — so the document reflects the
    // most recent attempt. The history endpoint treats `[]` and missing
    // identically (fall back to hardcoded), so persisting nothing is
    // equivalent to persisting empty.
    await CourseModel.findByIdAndUpdate(courseId, {
      suggestedDesignPrompts: prompts ?? [],
    });
    return prompts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    chatLog.warn(`design:prompts persist-fail course=${courseId} reason=${message}`);
    return null;
  }
};
