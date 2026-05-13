/**
 * Deterministic distractor linter.
 *
 * 2026-04-21 assessment follow-up: Sarah (creative / photography, casual
 * skim persona) scored 7/7 + 7/7 on Apply-level items at 0.60–0.90 confidence
 * while self-reporting "I picked the first reasonable option". The distractors
 * were plausible but didn't defend against surface pattern-match — the correct
 * answer was structurally distinguishable even without understanding.
 *
 * This linter checks three deterministic heuristics per quiz item:
 *   - length uniformity (all four options within ±35% of median length),
 *   - correct answer is not the strictly longest option,
 *   - absolute qualifiers ("always", "never", "only", "all", "none", "every",
 *     "any") appear in distractors ONLY when the correct answer also uses one.
 *
 * The lint runs pre-shuffle (so `correctIndex` still reflects the generation
 * order) and is SOFT-FAIL for the first cut: it returns reasons, logs, and
 * bumps a metric. It does NOT block or regenerate. If the observed miss rate
 * is high across real runs, promote to a regeneration trigger in a follow-up.
 */

export interface DistractorLintInput {
  options: string[];
  correctIndex: number;
}

export interface DistractorLintResult {
  lengthOk: boolean;
  correctNotLongest: boolean;
  absoluteQualifierOk: boolean;
  reasons: string[];
}

const ABSOLUTE_QUALIFIER_PATTERN = 'always|never|only|all|none|every|any';
const ABSOLUTE_QUALIFIER_RX = new RegExp(`\\b(${ABSOLUTE_QUALIFIER_PATTERN})\\b`, 'i');
const ABSOLUTE_QUALIFIER_RX_G = new RegExp(`\\b(${ABSOLUTE_QUALIFIER_PATTERN})\\b`, 'gi');

/**
 * Return true when a regex match at [start, end) is sitting inside a
 * code-like context — backticked span, CLI flag (`--all-namespaces`),
 * kwarg/assignment (`header=None`), namespaced or hyphenated identifier
 * (`foo.all`, `flag-all-foo`).
 *
 * The absolute-qualifier rule exists to keep prose distractors from
 * shipping skim-gameable tells. It is NOT meant for technical literals:
 * hedging `all → most` inside `--all-namespaces` produces
 * `--most-namespaces` (a kubectl flag that doesn't exist), and hedging
 * `None → Few` inside `header=None` produces `header=Few` (which the
 * persona explicitly used to eliminate the option). Skipping these
 * matches at both lint and repair time keeps technical strings intact.
 */
const isCodeContextMatch = ({ text, start, end }: { text: string; start: number; end: number }): boolean => {
  // Inside an open backtick span.
  const before = text.slice(0, start);
  const backticksBefore = (before.match(/`/g) ?? []).length;
  if (backticksBefore % 2 === 1) return true;

  // Adjacent to a code-syntactic character. `\b` already guarantees the
  // immediate neighbor is a non-word char; we look specifically for the
  // ones that signal "this is an identifier, not prose": `=`, `-`, `_`,
  // `/`, `\`. Sentence punctuation (. , ! ? ; :) and quotes/parens
  // intentionally excluded — those are prose boundaries.
  const prevCh = start > 0 ? text[start - 1] : '';
  const nextCh = end < text.length ? text[end] : '';
  const CODE_CHARS = /[=_/\\-]/;
  if (CODE_CHARS.test(prevCh) || CODE_CHARS.test(nextCh)) return true;

  // Namespaced identifier — `.all` or `all.` where the dot is mid-token
  // (word char on the other side), not a sentence-ending period.
  if (prevCh === '.' && start >= 2 && /\w/.test(text[start - 2])) return true;
  if (nextCh === '.' && end + 1 < text.length && /\w/.test(text[end + 1])) return true;

  return false;
};

/**
 * `text.matchAll` filtered through the code-context guard. Used by both
 * the lint check and the repair hedge so they stay in lockstep — a match
 * that doesn't trigger the lint must not be silently rewritten by the
 * repair, and vice versa.
 */
const hasProseAbsoluteQualifier = (text: string): boolean => {
  for (const m of text.matchAll(ABSOLUTE_QUALIFIER_RX_G)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (!isCodeContextMatch({ text, start, end })) return true;
  }
  return false;
};

// ±35% of median. Bumped from ±30% after production logs showed the
// feedback loop seesawing: fixing `correct-is-longest` often shortens the
// correct answer past the band, tripping length-uniformity. Widening the
// band absorbs most of that motion without weakening the skim-gaming
// defense (the real pick-the-longest guard is `correct-not-longest`).
const LENGTH_TOLERANCE = 0.35;

const median = (nums: number[]): number => {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/**
 * Run all three distractor-quality checks against a quiz item.
 *
 * Pure function — no IO, no randomness, no logging. Caller decides what to
 * do with failures (current policy: soft-fail / log / metric; do not block).
 */
export const lintDistractors = (input: DistractorLintInput): DistractorLintResult => {
  const { options, correctIndex } = input;
  const reasons: string[] = [];

  // Degenerate input guards — length rule needs ≥2 options; correct-not-longest
  // needs ≥2 options; index must be valid. These return a trivially-passing
  // result so the lint never errors out on malformed upstream state.
  if (!options || options.length < 2 || correctIndex < 0 || correctIndex >= options.length) {
    return { lengthOk: true, correctNotLongest: true, absoluteQualifierOk: true, reasons: [] };
  }

  const lengths = options.map((o) => o.length);
  const med = median(lengths);
  const lo = med * (1 - LENGTH_TOLERANCE);
  const hi = med * (1 + LENGTH_TOLERANCE);

  // Length uniformity.
  const lengthOk = lengths.every((l) => l >= lo && l <= hi);
  if (!lengthOk) reasons.push('length-uniformity');

  // Correct not strictly longest — tied-for-longest is acceptable because the
  // learner can't win by "pick the longest" in that case.
  const longestLen = Math.max(...lengths);
  const correctLen = lengths[correctIndex];
  const numAtLongest = lengths.filter((l) => l === longestLen).length;
  const correctNotLongest = correctLen < longestLen || numAtLongest > 1;
  if (!correctNotLongest) reasons.push('correct-is-longest');

  // Absolute qualifier discipline. Code-context matches (CLI flags,
  // kwargs, namespaced identifiers — see `isCodeContextMatch`) are
  // excluded: hedging `--all-namespaces` to `--most-namespaces` corrupts
  // the technical string without removing a real skim-gaming tell.
  const correctHasAbs = hasProseAbsoluteQualifier(options[correctIndex]);
  const distractorsHaveAbs = options.some(
    (o, i) => i !== correctIndex && hasProseAbsoluteQualifier(o),
  );
  const absoluteQualifierOk = correctHasAbs || !distractorsHaveAbs;
  if (!absoluteQualifierOk) reasons.push('distractor-absolute-qualifier');

  return { lengthOk, correctNotLongest, absoluteQualifierOk, reasons };
};

// ── Mechanical repair for residual lint violations ────────────
//
// Called by the quiz-generation nodes after the LLM-retry loop exhausts
// (see `interactiveGeneration.ts` / `quizGeneration.ts`). Two deterministic
// transforms handle the sticky-violation tail we can't prompt our way out
// of — production logs show `correct-is-longest` + `distractor-absolute-
// qualifier` persisting through 3 retries with targeted feedback because
// the model is at a local minimum: correct answers are naturally the most
// precise (longest), and padding distractors up to match leads it to reach
// for absolute-qualifier filler.
//
//   1. `distractor-absolute-qualifier` — replace absolute qualifiers in
//      DISTRACTORS (never the correct answer) with hedges:
//        never → rarely,  always → typically,  only → mainly,
//        all → most,  every → most,  any → most,  none → few.
//      The distractor's wrong-direction intent survives the hedge in
//      practice. Occasional grammatical awkwardness (especially around
//      `any → most` or `none → few`) is the accepted cost of not shipping
//      a test-gameable absolute-qualifier tell.
//
//   2. `correct-is-longest` — trim a trailing clause from the correct
//      answer. Try cuts gentlest-first (em-dash justification, `because`
//      clause, semicolon, final comma); commit the first cut that makes
//      the correct answer no longer strictly longest AND leaves at least
//      8 chars. Give up otherwise.
//
// `length-uniformity` is deliberately NOT repaired — shifting options into
// the median band without changing meaning is unreliable, and it's the
// least common of the three in residual violations after the feedback
// loop, so letting it ship is the acceptable tradeoff.

const ABSOLUTE_HEDGE: Record<string, string> = {
  always: 'typically',
  never: 'rarely',
  only: 'mainly',
  all: 'most',
  none: 'few',
  every: 'most',
  any: 'most',
};

const preserveLeadingCase = ({ original, replacement }: { original: string; replacement: string }): string => {
  if (!original || !replacement) return replacement;
  const firstIsUpper = original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase();
  if (!firstIsUpper) return replacement;
  return replacement[0].toUpperCase() + replacement.slice(1);
};

const hedgeAbsoluteQualifiers = (text: string): string => {
  return text.replace(ABSOLUTE_QUALIFIER_RX_G, (match, _group, offset: number) => {
    // Skip code-context matches (CLI flags like `--all-namespaces`,
    // kwargs like `header=None`, namespaced identifiers). The hedge is
    // meant for prose distractors; substituting `all → most` inside a
    // technical literal produces invalid commands and confuses learners.
    if (isCodeContextMatch({ text, start: offset, end: offset + match.length })) return match;
    const hedge = ABSOLUTE_HEDGE[match.toLowerCase()];
    if (!hedge) return match;
    return preserveLeadingCase({ original: match, replacement: hedge });
  });
};

const TAIL_TRIM_PATTERNS: RegExp[] = [
  /\s+—\s+.+$/,          // em-dash justification
  /,\s*because\s+.+$/i,  // `because` clause
  /;\s+.+$/,             // semicolon-separated follow-up
  /,\s+[^,]+$/,          // final clause after last comma (most aggressive)
];

const MIN_TRIMMED_CORRECT_LENGTH = 8;

const tailTrimCandidates = (text: string): string[] => {
  const out: string[] = [];
  for (const rx of TAIL_TRIM_PATTERNS) {
    const trimmed = text.replace(rx, '').trim();
    if (trimmed.length >= MIN_TRIMMED_CORRECT_LENGTH && trimmed !== text) out.push(trimmed);
  }
  return out;
};

export type DistractorRepairLabel = 'absolute-qualifier' | 'correct-tail-trim';

export interface DistractorRepairResult {
  options: string[];
  correctIndex: number;
  changed: boolean;
  appliedRepairs: DistractorRepairLabel[];
}

/**
 * Apply deterministic repairs for the two sticky lint rules the model
 * can't reliably drive to zero through prompt feedback alone.
 *
 * Pure function — no IO, no randomness, no logging. Caller decides whether
 * to commit the repaired options to a block / question and whether to bump
 * a "repaired" metric. `correctIndex` is preserved (we never reorder).
 *
 * Returns the original input unchanged (with `changed: false`) when the
 * input already passes lint, when neither repair applies, or when the
 * input is degenerate (malformed options / out-of-bounds index).
 */
export const repairDistractors = (input: DistractorLintInput): DistractorRepairResult => {
  const { options, correctIndex } = input;

  if (!options || options.length < 2 || correctIndex < 0 || correctIndex >= options.length) {
    return { options, correctIndex, changed: false, appliedRepairs: [] };
  }

  let working = [...options];
  const appliedRepairs: DistractorRepairLabel[] = [];
  const initialLint = lintDistractors({ options: working, correctIndex });

  if (initialLint.reasons.includes('distractor-absolute-qualifier')) {
    const next = working.map((opt, i) => (i === correctIndex ? opt : hedgeAbsoluteQualifiers(opt)));
    if (next.some((o, i) => o !== working[i])) {
      working = next;
      appliedRepairs.push('absolute-qualifier');
    }
  }

  const afterHedgeLint = lintDistractors({ options: working, correctIndex });
  if (afterHedgeLint.reasons.includes('correct-is-longest')) {
    const candidates = tailTrimCandidates(working[correctIndex]);
    for (const candidate of candidates) {
      const probe = [...working];
      probe[correctIndex] = candidate;
      const probeLint = lintDistractors({ options: probe, correctIndex });
      if (!probeLint.reasons.includes('correct-is-longest')) {
        working = probe;
        appliedRepairs.push('correct-tail-trim');
        break;
      }
    }
  }

  const changed = working.some((o, i) => o !== options[i]);
  return { options: working, correctIndex, changed, appliedRepairs };
};
