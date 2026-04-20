/**
 * Schema + helpers for validating the clarify-generation agent's output and
 * for tagging thin free-text answers.
 *
 * Split out of courseService.ts so tests can import this module without
 * pulling in the LangChain models (which require ANTHROPIC_API_KEY +
 * ENVIRONMENT at import time via @conf/env). Keeping the validation surface
 * pure keeps the test loop fast and env-free.
 */

import { z } from 'zod';
import { jsonish } from '@lib/zodHelpers';
import { QUESTION_TYPES } from '@lib/constants';

/**
 * Marker-fragment used by `clarifyCourse` to distinguish refinement-triggered
 * retries from generic JSON-parse failures. The refinement message must
 * start with this exact prefix so the detector in courseService.ts stays in
 * sync. Changing the marker is a breaking change — update both sides.
 */
export const CLARIFY_TEXT_QUESTION_REFINEMENT_MARKER =
  'At least one clarify question must be type="text"';

export const clarifyOutputSchema = z.object({
  courseName: z.string(),
  questions: jsonish(z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      type: z.enum(QUESTION_TYPES),
      options: z.array(z.string()).nullable(),
    }),
  )).refine(
    (questions) => questions.some((q) => q.type === 'text'),
    {
      // Hard contract: every clarify set must include at least one free-text
      // question. Without it, learners can't supply a concrete artifact
      // (project name, stakeholder, dataset, constraint) for downstream
      // generation to thread through lessons and examples. withRetry (3
      // retries, exponential backoff) will catch Zod failures here and
      // re-invoke the LLM; if 4 attempts produce zero text questions, the
      // job fails loudly rather than silently shipping a closed-option set.
      message: `${CLARIFY_TEXT_QUESTION_REFINEMENT_MARKER} so the learner can name a concrete artifact that downstream generation can thread through lessons and examples.`,
    },
  ),
});

export type ClarifyOutput = z.infer<typeof clarifyOutputSchema>;

/**
 * Tags answers that came from a text-type clarify question but are too short
 * to support confident scope decisions. Consumed by `formatCourseAnswers` in
 * jobRunner.ts, which injects a `[thin answer — weak signal]` marker so the
 * structure-generation prompt can branch toward conservative scope instead
 * of over-reading two-word replies as confident artifact specifications.
 *
 * Rule: ≤3 whitespace-separated tokens. Deliberately permissive — a
 * single-token response like "C++" or "React" will trigger this, but
 * conservative structure scoping is a safe failure mode for a low-
 * information signal. False negatives (long-but-vague answers like
 * "I might be assigned to work on projects that involve collaboration")
 * are out of scope for this heuristic — detecting vagueness without
 * NLP is brittle.
 */
export const isThinFreeText = (answer: string): boolean => {
  if (!answer || typeof answer !== 'string') return false;
  const tokens = answer.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.length <= 3;
};
