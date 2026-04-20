import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getUtilityModel } from '@lib/langchain';
import { withRetry } from '@lib/retry';
import { InsightKind } from '@lib/insightConstants';

// ── Types ──────────────────────────────────────────────────

export type GradeVerdict = 'correct' | 'partial' | 'incorrect';

export interface GradeResult {
  /** 0..1 — semantic correctness/completeness. */
  score: number;
  verdict: GradeVerdict;
  /** Short teaching feedback, ≤ 20 words. */
  feedback: string;
}

// ── Prompt + schema ───────────────────────────────────────

const gradeSchema = z.object({
  score: z.number().min(0).max(1).describe('0..1 — semantic correctness and completeness of the learner\'s answer'),
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  feedback: z.string().describe('One short sentence (≤ 20 words, target ≤ 160 chars) teaching what was right or missing'),
});

const SYSTEM_PROMPT = `You grade a learner's free-recall attempt against a canonical answer.

Return structured JSON with:
- score: 0..1 — semantic correctness AND completeness. Full credit for paraphrases that preserve meaning; partial credit when the key idea is present but a material detail is missing or wrong.
- verdict: 'correct' (score ≥ 0.85), 'partial' (0.4 ≤ score < 0.85), 'incorrect' (< 0.4).
- feedback: one short sentence (≤ 20 words), upbeat and educational. For partial/incorrect, name what was missed. For correct, briefly affirm or add a small reinforcement.

Grading principles:
- Reward semantic match over surface match. Synonyms, paraphrases, and different word order are fine.
- Do not penalize punctuation, capitalization, typos, or articles.
- If the learner's answer only names part of a multi-part canonical answer, it's 'partial', not 'correct'.
- If the answer is off-topic, a restatement of the question, or gibberish → 'incorrect' with score 0.
- Treat the canonical answer as ground truth — don't second-guess it even if you disagree.

Return ONLY the JSON — no preamble, no markdown fences.`;

// ── Grade ─────────────────────────────────────────────────

/**
 * Grade a learner's free-recall attempt via Haiku. No short-circuit: even
 * verbatim matches go through the model so grading is consistent and
 * explanations are always semantic, not surface-level.
 *
 * If the model call fails, the error propagates — the client's mutation is
 * configured `silent`, so the card degrades gracefully to self-rating on
 * the 4-button scale without a verdict pill.
 */
export const gradeTypedAnswer = async (params: {
  prompt: string;
  canonicalAnswer: string;
  userAnswer: string;
  kind: InsightKind;
}): Promise<GradeResult> => {
  const trimmed = params.userAnswer.trim();
  if (!trimmed) {
    return { score: 0, verdict: 'incorrect', feedback: 'No answer provided.' };
  }

  const humanMessage = params.kind === 'cloze'
    ? `## Cloze sentence
${params.prompt}

## Canonical answer for the blank
${params.canonicalAnswer}

## Learner's answer
${trimmed}`
    : `## Question
${params.prompt}

## Canonical answer
${params.canonicalAnswer}

## Learner's answer
${trimmed}`;

  const model = getUtilityModel().withStructuredOutput(gradeSchema);
  const result = await withRetry(() =>
    model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(humanMessage),
    ]),
  );

  return {
    score: Math.max(0, Math.min(1, result.score)),
    verdict: result.verdict,
    feedback: result.feedback,
  };
};
