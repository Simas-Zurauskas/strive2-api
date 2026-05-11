/**
 * Strip AI self-correction artifacts from LLM-generated text before it
 * reaches a learner. The lesson-generation and quiz-generation agents
 * occasionally emit meta-reasoning ("Actually: 4 × 200px = 800px...",
 * "Re-selecting correctIndex to 2") into fields that are rendered as-is —
 * this utility pattern-matches those sentences and removes them.
 *
 * Sibling to `latexSanitizer.ts`: same shape (one pure function, input
 * string → result with metadata), same defensive-filter philosophy.
 * Runs AFTER latexSanitizer in the pipeline so the LaTeX pass can validate
 * `$…$` spans without interference from artifact regexes (which don't
 * touch `$`).
 */

export interface ArtifactSanitizeResult {
  text: string;
  stripped: number;
  gutted: boolean;
}

/**
 * High-precision meta-phrase patterns. Each pattern is a full sentence or
 * clause; matches are replaced with the empty string. Every pattern is
 * bounded by `[^.\n]*` so a single match never crosses a line or sentence
 * boundary — prevents greedy runs from eating surrounding prose.
 *
 * New patterns go here. Keep the false-positive bar high: a pattern must
 * be unambiguously AI self-talk, not phrasing a human educator might use
 * naturally.
 */
export const ARTIFACT_PATTERNS: { name: string; pattern: RegExp }[] = [
  // "Re-selecting correctIndex to 2" — correctIndex is a schema field name;
  // only an LLM writing meta-JSON-talk produces this phrase.
  { name: 'reselecting_correctIndex', pattern: /\bRe-?selecting\s+correctIndex\b[^.\n]*\.?/gi },

  // "updating the explanation accordingly" — self-instruction to modify own output.
  { name: 'updating_explanation', pattern: /\bupdating the explanation accordingly\b[^.\n]*\.?/gi },

  // "Let me re-examine / reconsider / recalculate…" — first-person self-direction.
  // Teaching prose says "re-examine your work", not "Let me re-examine".
  { name: 'let_me_self_direction', pattern: /\bLet me (re-?examine|reconsider|re-?check|double-?check|recalculate)\b[^.\n]*\.?/gi },

  // "The correct answer should be…" — LLM indecision. Legitimate explanations
  // use "The correct answer is", not "should be".
  { name: 'answer_should_be', pattern: /\bThe (correct )?answer should be\b[^.\n]*\.?/gi },

  // "I should pick/select/choose…" — first-person self-direction.
  { name: 'i_should_pick', pattern: /\bI should (pick|select|choose|change|update)\b[^.\n]*\.?/gi },

  // "Actually: <arithmetic>" — "Actually" as a sentence-opening colon
  // followed by a numeric self-correction. The arithmetic-symbol requirement
  // keeps this from false-matching "Actually, the subject was a pioneer…" —
  // that's no colon, no digits, no arithmetic operators.
  { name: 'actually_arithmetic', pattern: /\bActually:\s+[^.\n]*[0-9×=<>≤≥][^.\n]*\./gi },

  // "Wait, that's / let me / I need…" — AI backtracking. Teaching prose uses
  // "Wait for…" or "Wait until…", never "Wait, that's…" at sentence start.
  { name: 'wait_backtrack', pattern: /\bWait,\s+(that('| i)s| let me| I need)\b[^.\n]*\.?/gi },

  // "wait, consider these N actual options" — observed in MCQ stems where the
  // model wrote some options, then self-corrected with a meta-instruction to
  // the schema field. The phrase "actual options" is the LLM tell — humans do
  // not call options "actual" in teaching prose, so the false-positive surface
  // is essentially zero. Bounded by `[^.\n]*` like the rest so a single match
  // never crosses sentences. Kept narrow on purpose: a generic "wait, consider"
  // strip would over-collapse legitimate prose ("wait, consider both sides").
  { name: 'wait_consider_actual_options', pattern: /\b(?:—\s*)?wait,?\s+consider\s+(?:these\s+)?(?:\w+\s+)?actual\s+options?\b[^.\n]*\.?/gi },
];

/**
 * Fraction of non-whitespace content that must survive for the result to
 * NOT be classified as gutted. Tuned to 40% → if >60% was stripped, treat
 * the field as unsalvageable and let the caller substitute a fallback.
 */
const GUTTED_SURVIVAL_FLOOR = 0.4;

/**
 * Run every artifact pattern against `text`, collapse whitespace left by
 * strips, and return the result with counters. Safe on `null` / non-string
 * / empty input (returns a well-formed no-op result).
 *
 * Idempotent: running twice is equivalent to running once.
 */
export const sanitizeArtifacts = (text: string): ArtifactSanitizeResult => {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', stripped: 0, gutted: false };
  }

  const originalNonWs = text.replace(/\s+/g, '').length;

  let out = text;
  let stripped = 0;

  for (const { pattern } of ARTIFACT_PATTERNS) {
    out = out.replace(pattern, () => {
      stripped += 1;
      return '';
    });
  }

  if (stripped > 0) {
    // Collapse the whitespace left behind by the strips so the surviving
    // prose reads cleanly. Only touches whitespace — never rewords.
    out = out
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+\./g, '.')
      .replace(/\s+,/g, ',')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const remainingNonWs = out.replace(/\s+/g, '').length;
  const gutted = originalNonWs > 0 && remainingNonWs / originalNonWs < GUTTED_SURVIVAL_FLOOR;

  return { text: out, stripped, gutted };
};
