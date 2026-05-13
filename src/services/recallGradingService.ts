import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getUtilityModel } from '@lib/langchain';
import { withRetry } from '@lib/retry';
import { RecallCardKind } from '@lib/recallConstants';

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

You are scoring CONCEPT CAPTURE, not phrase match. The learner has recalled the right idea if they name the same concept or mechanism as the canonical — in any words. Different vocabulary for the same underlying mechanism is full credit; missing a distinct part of the concept is partial.

Return structured JSON with:
- score: 0..1 — how well the learner captured the canonical concept(s).
- verdict: 'correct' (score ≥ 0.85), 'partial' (0.4 ≤ score < 0.85), 'incorrect' (< 0.4).
- feedback: one short sentence (≤ 20 words), upbeat and educational. For partial/incorrect, name the concept or mechanism that was missed (not a missing word). For correct, briefly affirm or add a small reinforcement.

Scoring rubric:
- **Full credit (correct)** when the learner names the same concept(s) as the canonical, even in different words. Synonyms, paraphrases, different word order, different level of abstraction that still identifies the same mechanism — all full credit. "Two-way" vs "collaborative" inspection, "trade-off conversation" vs "negotiate to minimize impact", "lexical scoping" vs "closure over outer variables" — these are the SAME concept and score ≥ 0.85.
- **Partial** only when the canonical has multiple DISTINCT parts (A and B, or mechanism + condition) and the learner named fewer than all of them, OR when the learner names a mechanism without the qualifying condition that makes it correct. Partial is for missing CONCEPTS, not missing WORDS.
- **Incorrect** when the answer is off-topic, names the wrong mechanism, restates the question, or is gibberish.

Hard rules:
- Do not deduct for vocabulary choice when the underlying idea matches.
- Do not deduct for punctuation, capitalization, typos, articles, or hedging ("I think", "maybe").
- **Grade only against what the canonical actually says.** The canonical is your entire ground truth. Do NOT invent extra requirements the canonical did not list — no "they also should have mentioned X", no "they didn't note that this accepts both string and int", no "but the canonical implies more context." If the prompt asks for an argument name and the canonical is "sheet_name", a learner answer of "sheet_name" is FULL CREDIT (1.0) — even if there is a broader story about what sheet_name accepts, that story is not in the canonical so it is not graded.
- **Containment counts.** If the learner's answer fully contains the canonical (verbatim or trivially inflected) and adds extra correct or harmless detail, that is FULL CREDIT, not partial. A numeric range from the learner that fully contains the canonical range (e.g. user "$150–$250" vs canonical "$175–$225") is correct — the canonical span sits inside the learner's span.
- Before scoring below 0.85, ask: "Did the learner miss a DISTINCT CONCEPT from the canonical, or just use different words / add extra detail / wrap the canonical in a wider span?" If any answer is "yes, just words/detail/wider span" → 0.85+.
- Treat the canonical answer as ground truth — don't second-guess it even if you disagree.
- If the answer omits part of a compound canonical (e.g. canonical = "X because Y"; learner says only X), score partial around 0.5–0.7 based on how load-bearing the missing part is.

Worked examples:
- Q: "What argument do you pass to read_excel to pick the sheet?" / canonical: "sheet_name" / learner: "sheet_name" → score 1.0, verdict correct. The learner named the exact canonical; demands beyond that ("they didn't mention it accepts both string and int positions") are NOT in the canonical, do not deduct.
- Q: "Atlanta mid-tier mini-session price band?" / canonical: "$175–$225" / learner: "$150–$250" → score ≥ 0.9, verdict correct. The learner's range fully contains the canonical band; that's wider, not wrong.
- Q: "FSRS memory model variables besides Difficulty and Retrievability?" / canonical: "Stability" / learner: "Stability and Lapses" → partial around 0.7. The learner named the right concept but added a wrong one — the qualifying scope changed.

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
  kind: RecallCardKind;
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
    model.invoke(
      [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(humanMessage)],
      { metadata: { llmLabel: 'recall:grade' } },
    ),
  );

  return {
    score: Math.max(0, Math.min(1, result.score)),
    verdict: result.verdict,
    feedback: result.feedback,
  };
};
