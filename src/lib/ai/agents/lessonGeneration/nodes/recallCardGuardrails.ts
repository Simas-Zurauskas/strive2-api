/**
 * Cloze / qa authoring guardrails.
 *
 * Extracted from recallCardGeneration.ts so unit tests can import the validator
 * without pulling the LangChain side-effects that its parent module requires
 * at import time (env-var guards, LLM client construction).
 *
 * Why these rules exist — 2026-04-21 assessment rubric follow-up:
 *   - John's cloze canonical answer was "API" in a React-props context
 *     where "props", "interface", and "shape" all fit → ambiguous stem.
 *   - Alex's cloze canonical was `"_".join(col).strip("_") or a pipe(flatten_columns)
 *     helper` — an entire code-expression disjunction. Typed-recall then
 *     scored the learner's "reset_index" at 0.15.
 *   - Mike's cloze had two blanks in one sentence ("{{blank}} and {{blank}}
 *     are marker traits"), violating atomicity.
 *
 * The RECALL_CARD_SYSTEM_PROMPT tightening is the primary defense; this module
 * is belt-and-braces. Failed candidates are dropped silently upstream —
 * lessons ship with fewer recall cards rather than worse ones.
 */

import { RECALL_CARD_KINDS } from '@lib/recallConstants';

// Candidate shape — mirrors the Zod schema in recallCardGeneration.ts, but kept
// as a plain interface here so this module has zero Zod/Langchain deps.
export interface RecallCardCandidateLike {
  kind: (typeof RECALL_CARD_KINDS)[number];
  prompt: string;
  answer: string;
  conceptTags?: string[];
  sourceBlockId: string;
}

const CLOZE_BLANK_RX = /\{\{\s*blank\s*\}\}/gi;
/** Disjunctions: " or ", " / ", " OR " (word-boundary), " and " between atoms. */
const CLOZE_DISJUNCTION_RX = /(\s+(?:or|OR|\/|and)\s+)/;
/** Function calls, chained methods, backticks, or parenthesized alternatives. */
const CODE_EXPR_RX = /[`()]|\.[a-z_]\w*\s*\(|=>|\bfunction\b/i;
/** Opening quotes / leading parens. Possessive `'s` is carved out explicitly. */
const DISALLOWED_PUNCT_RX = /[()"]|(?<!\w)'/;
/** Compound "X and Y" where both sides are proper-noun-like (capitalized atoms). */
const SPLITTABLE_AND_RX = /\b[A-Z][\w-]*\s+and\s+[A-Z][\w-]*\b/;

/**
 * Curriculum-meta tells. Stems that reference the course/lesson/module as
 * an object of study (rather than the domain content) score curriculum
 * trivia, not learning. Hits like "this course", "in this lesson", "the
 * three practice tables", "the modules in this course are" are dropped.
 */
const CURRICULUM_META_RX = /\b(?:this\s+(?:course|lesson|module|unit)|in\s+this\s+(?:course|lesson|module|unit)|the\s+(?:lessons?|modules?|units?|chapters?)\s+(?:in|of)\s+this)\b/i;

/**
 * Numeric-range cloze answers. "$150-$250", "30-60 seconds", "60–90" —
 * any answer matching `<digits><dash><digits>` (with optional currency
 * prefix and optional unit suffix). Ranges admit two-sided ambiguity:
 * the user's wider range fully contains the canonical and is still
 * graded partial. Better to make these qa cards where the answer
 * narrates the range explicitly.
 */
const NUMERIC_RANGE_RX = /^\s*[$€£¥]?\s*\d[\d,.]*\s*[-–—]\s*[$€£¥]?\s*\d[\d,.]*(?:\s*\w+)?\s*$/;

/**
 * Approximate cloze-stem-telegraphs-the-answer check. The model is
 * primarily defended in the system prompt; this catches the residual
 * case where the canonical answer (or its near-identical token) appears
 * verbatim in the stem. False-positive risk is real (a canonical that
 * is also a common stop word would trigger), so we require the canonical
 * to be ≥4 chars and not appear inside the {{blank}} placeholder span.
 */
const looksLikeStemTelegraph = ({ stem, answer }: { stem: string; answer: string }): boolean => {
  const ans = answer.trim().toLowerCase();
  if (ans.length < 4) return false;
  const stemMinusBlank = stem.replace(CLOZE_BLANK_RX, '').toLowerCase();
  // Whole-word boundary so "table" doesn't false-match inside "constable".
  // Escape regex-meta chars in the answer.
  const escaped = ans.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`\\b${escaped}\\b`);
  return rx.test(stemMinusBlank);
};

export interface ValidationOutcome {
  valid: boolean;
  reason?: string;
}

/**
 * Pure string-logic validator over a candidate recall card. Returns {valid:true}
 * for passing candidates and {valid:false, reason} for dropped ones. Reason
 * is for logging/observability only — never surfaced to clients.
 */
export const validateRecallCardCandidate = (c: RecallCardCandidateLike): ValidationOutcome => {
  const promptTrim = c.prompt.trim();
  const answerTrim = c.answer.trim();

  // Curriculum-meta cards apply to both qa and cloze: a stem referencing
  // "this course / lesson / module" is testing curriculum trivia, not
  // domain knowledge, and there's no canonical for orderings like
  // "the three practice tables are X, products, orders".
  if (CURRICULUM_META_RX.test(promptTrim)) {
    return { valid: false, reason: 'curriculum-meta' };
  }

  if (c.kind === 'cloze') {
    // Exactly one blank marker.
    const blanks = promptTrim.match(CLOZE_BLANK_RX);
    const blankCount = blanks?.length ?? 0;
    if (blankCount !== 1) return { valid: false, reason: `cloze:blanks=${blankCount}` };

    // Token count after normalizing LaTeX spans and backticked spans to one token.
    const normalized = answerTrim
      .replace(/\$[^$]*\$/g, 'X')
      .replace(/`[^`]*`/g, 'X')
      .trim();
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length > 3) return { valid: false, reason: `cloze:tokens=${tokens.length}` };

    // Disjunctions / compound atoms — use the raw answer, not the LaTeX-stripped one.
    if (CLOZE_DISJUNCTION_RX.test(answerTrim)) {
      return { valid: false, reason: 'cloze:disjunction' };
    }

    // Code expressions.
    if (CODE_EXPR_RX.test(answerTrim)) {
      return { valid: false, reason: 'cloze:code-expr' };
    }

    // Disallowed punctuation (quotes, parens). Possessive "'s" is fine.
    if (DISALLOWED_PUNCT_RX.test(answerTrim)) {
      return { valid: false, reason: 'cloze:punctuation' };
    }

    // Numeric-range answers ($150–$250, 30–60 seconds, 60–90). Ambiguous
    // by construction; ranges should be qa cards, not clozes.
    if (NUMERIC_RANGE_RX.test(answerTrim)) {
      return { valid: false, reason: 'cloze:numeric-range' };
    }

    // Stem telegraphs the answer — canonical appears verbatim outside
    // the {{blank}} placeholder. See the prompt's "double-bracket"
    // counter-example for the motivating regression.
    if (looksLikeStemTelegraph({ stem: promptTrim, answer: answerTrim })) {
      return { valid: false, reason: 'cloze:stem-telegraphs-answer' };
    }
  }

  if (c.kind === 'qa') {
    const words = answerTrim.split(/\s+/).filter(Boolean);
    if (words.length > 15) return { valid: false, reason: `qa:words=${words.length}` };

    // Compound "X and Y" where both sides are capitalized atoms — ask the
    // author to split into two cards. Narrative "and" in lower-case text
    // (e.g. "trial and error") is allowed.
    if (SPLITTABLE_AND_RX.test(answerTrim)) {
      return { valid: false, reason: 'qa:compound-and' };
    }
  }

  return { valid: true };
};
