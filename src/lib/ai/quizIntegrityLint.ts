/**
 * Deterministic quiz-integrity linter — sibling to `distractorLint.ts`.
 *
 * Where `distractorLint` checks distractor *style* (length uniformity, the
 * correct option not being the longest, absolute-qualifier discipline), this
 * module checks quiz *integrity* — invariants that must hold or the quiz is
 * functionally broken regardless of style:
 *
 *   - duplicate-options: two or more options have identical text after
 *     whitespace + casefold normalization. Reduces the answer set from 4 to 3
 *     and leaks information ("the matching pair are probably both wrong").
 *   - truncated-correct: the option at `correctIndex` is conspicuously
 *     shorter than its peers AND ends mid-clause / on a trailing conjunction
 *     / as a bare SQL keyword fragment. The persona reasonably eliminates it
 *     on syntax grounds and gets graded "incorrect" on the question they
 *     actually answered correctly.
 *   - explanation-mismatch: the `explanation` paragraph argues for an option
 *     that's not the one `correctIndex` points to. Either an explicit
 *     textual cite ("Option B is correct…") disagrees with the index, OR
 *     the signature-token overlap with the explanation peaks at a non-
 *     `correctIndex` option by a margin of ≥2.
 *
 * Origin: 2026-05-02 debug-orchestrator assessment found these defects in
 * the Marcus-data-analyst Module-1 quiz (Q8 had two duplicate options;
 * Q1 + Q4 had `correctIndex` pointing to truncated SQL fragments). Fix is
 * RICE-#2 in the assessment roadmap.
 *
 * Pure function — no IO, no randomness, no logging. Caller decides what to
 * do with violations (current policy: feed back into the LLM-retry loop;
 * ship-with-warning if both attempts exhausted).
 *
 * Runs PRE-shuffle so token-overlap and `correctIndex` references reason
 * about the same option indices. The three checks are also shuffle-safe —
 * the (options, correctIndex, explanation) tuple keeps its semantic shape
 * after shuffling — but running pre-shuffle keeps this consistent with the
 * existing `distractorLint` invocation point.
 */

export interface QuizIntegrityLintInput {
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface QuizIntegrityLintResult {
  reasons: string[];
}

// ── Shared helpers ────────────────────────────────────────────

const STOPWORDS = new Set<string>([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'his', 'has', 'had', 'how', 'its', 'who', 'did', 'yes',
  'get', 'any', 'new', 'now', 'too', 'two', 'use', 'way', 'why', 'this', 'that',
  'with', 'from', 'have', 'they', 'will', 'would', 'could', 'should', 'when',
  'where', 'which', 'what', 'than', 'them', 'then', 'there', 'these', 'those',
  'into', 'onto', 'over', 'such', 'some', 'each', 'also', 'because', 'while',
  'about', 'after', 'before', 'being', 'been', 'were', 'their', 'your', 'most',
  'more', 'less', 'only', 'just', 'very', 'much', 'many', 'both', 'same',
  'other', 'every', 'else', 'still', 'first', 'last', 'next',
]);

const tokenize = (s: string): string[] => {
  return s
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
};

// ── Defect 1: duplicate options ───────────────────────────────

const normalizeOption = (s: string): string => {
  return s
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;]+$/, '')
    .toLocaleLowerCase('en');
};

const detectDuplicates = (options: string[]): boolean => {
  const seen = new Set<string>();
  for (const opt of options) {
    const norm = normalizeOption(opt);
    // Empty after normalization → two empty strings would also be a duplicate
    // pair, but the upstream Zod schema requires non-empty option strings, so
    // treat `''` as never-seen to avoid false-firing on degenerate input that
    // shouldn't reach us anyway.
    if (norm.length === 0) continue;
    if (seen.has(norm)) return true;
    seen.add(norm);
  }
  return false;
};

// ── Defect 2: truncated correct option ────────────────────────

const median = (nums: number[]): number => {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

// STRONG trailing signals — fire on their own. These patterns never appear
// in well-formed prose / code; their presence at end-of-string is itself the
// truncation evidence regardless of how long the option happens to be.
const STRONG_TRAILING_PATTERNS: RegExp[] = [
  // Trailing comma, em-dash, en-dash, or ellipsis with nothing after.
  /[,—–…]\s*$/,
  // Trailing conjunction or SQL clause keyword with nothing after. The
  // bounding `\s+` requires at least one whitespace before, so words ending
  // in 'and' / 'or' (like "demand", "for") are NOT matched.
  /\s+(and|or|but|AS|BY|ON|WHERE|FROM|GROUP|ORDER|HAVING|JOIN)\s*$/i,
  // Half-formed identifier assignment ("foo = ").
  /[A-Za-z_][A-Za-z0-9_]*\s*=\s*$/,
];

const SQL_KEYWORD_START_RX = /^\s*(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|JOIN|INSERT|UPDATE|DELETE)\b/i;

const hasUnbalancedDelimiters = (s: string): boolean => {
  // Count opens/closes for paren / bracket / brace and quote pairs.
  // Strings ending mid-quote/paren are a strong truncation signal.
  const counts = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
  let singleQuotes = 0;
  let doubleQuotes = 0;
  let backticks = 0;
  for (const ch of s) {
    if (ch in counts) counts[ch as keyof typeof counts] += 1;
    else if (ch === "'") singleQuotes += 1;
    else if (ch === '"') doubleQuotes += 1;
    else if (ch === '`') backticks += 1;
  }
  if (counts['('] !== counts[')']) return true;
  if (counts['['] !== counts[']']) return true;
  if (counts['{'] !== counts['}']) return true;
  if (singleQuotes % 2 !== 0) return true;
  if (doubleQuotes % 2 !== 0) return true;
  if (backticks % 2 !== 0) return true;
  return false;
};

const hasStrongTruncationSignal = (correct: string): boolean => {
  if (STRONG_TRAILING_PATTERNS.some((rx) => rx.test(correct))) return true;
  if (hasUnbalancedDelimiters(correct)) return true;
  return false;
};

// WEAK trailing signal — SQL-fragment heuristic. Fires only when paired with
// the length signal. A correct option that legitimately starts with `SELECT`
// and is a complete statement should NOT trip this; we require BOTH (a) the
// option lacks a statement terminator while peers contain one AND (b) the
// option is conspicuously short relative to peers. Both together strongly
// suggest the model emitted a clause where it meant a statement.
const looksLikeSqlFragment = ({
  correct,
  peers,
}: {
  correct: string;
  peers: string[];
}): boolean => {
  if (!SQL_KEYWORD_START_RX.test(correct)) return false;
  if (/;/.test(correct)) return false;
  const peerLooksFull = peers.some((p) => SQL_KEYWORD_START_RX.test(p) && (/;/.test(p) || /\bFROM\b/i.test(p)));
  return peerLooksFull;
};

const detectTruncatedCorrect = ({ options, correctIndex }: { options: string[]; correctIndex: number }): boolean => {
  if (correctIndex < 0 || correctIndex >= options.length) return false;
  const correct = options[correctIndex];
  const peers = options.filter((_, i) => i !== correctIndex);
  if (peers.length === 0) return false;

  // Strong signals fire alone — these patterns are unambiguous truncation
  // evidence (trailing comma / hanging conjunction / half-formed identifier /
  // unbalanced quote). They appear in NEITHER short legitimate answers
  // ("True", "$5M") NOR longer prose answers, so length-gating them would
  // miss real defects like the "...with SUM," fixture.
  if (hasStrongTruncationSignal(correct)) return true;

  // Weak signal — SQL fragment — requires length confirmation. Length-ratio
  // signal protects T/F and short-numeric questions. Both must hold:
  //   (a) correct < 0.55 × medianPeerLen → conspicuously shorter relative
  //   (b) correct < 40 chars              → absolute floor (a 70-char correct
  //       answer is "complete" even if peers happen to be 200 chars)
  const correctLen = correct.length;
  const medianPeerLen = median(peers.map((p) => p.length));
  const lenSignal = correctLen < 0.55 * medianPeerLen && correctLen < 40;
  if (!lenSignal) return false;

  return looksLikeSqlFragment({ correct, peers });
};

// ── Defect 3: correctIndex ↔ explanation mismatch ─────────────

// Path 1 — explicit textual cite. High-confidence, runs always.
const TEXTUAL_CITE_PATTERNS: RegExp[] = [
  /\b(?:option|choice|answer)\s+([A-D]|[1-4])\b/i,
  /\b([A-D])\s+(?:is|would\s+be)\s+(?:the\s+)?(?:correct|right|answer)\b/i,
];

const letterOrNumberToIndex = (token: string): number | null => {
  const t = token.toUpperCase();
  if (t === 'A') return 0;
  if (t === 'B') return 1;
  if (t === 'C') return 2;
  if (t === 'D') return 3;
  if (t === '1') return 0;
  if (t === '2') return 1;
  if (t === '3') return 2;
  if (t === '4') return 3;
  return null;
};

const detectExplicitCiteMismatch = ({
  explanation,
  correctIndex,
  optionCount,
}: {
  explanation: string;
  correctIndex: number;
  optionCount: number;
}): boolean => {
  for (const rx of TEXTUAL_CITE_PATTERNS) {
    const match = explanation.match(rx);
    if (!match) continue;
    const cited = letterOrNumberToIndex(match[1]);
    if (cited === null) continue;
    if (cited >= optionCount) continue; // ignore citations to options that don't exist
    if (cited !== correctIndex) return true;
  }
  return false;
};

// Path 2 — signature-token overlap. Heuristic, runs only when ALL options
// are ≥ 40 chars (short options have nothing to match against and would
// false-positive on token-poor inputs).
const SIG_TOKEN_MIN_OPTION_LEN = 40;
const SIG_TOKEN_MARGIN = 2;
const SIG_TOKEN_MIN_WIN_SCORE = 2;

const detectSignatureOverlapMismatch = ({
  options,
  correctIndex,
  explanation,
}: {
  options: string[];
  correctIndex: number;
  explanation: string;
}): boolean => {
  if (options.some((o) => o.length < SIG_TOKEN_MIN_OPTION_LEN)) return false;

  const optionTokens = options.map((o) => new Set(tokenize(o)));
  const explanationTokens = new Set(tokenize(explanation));

  // For each option i, "unique_i" = tokens that appear in option i but in NO
  // other option. Score = |unique_i ∩ explanation_tokens|.
  const scores: number[] = options.map((_, i) => {
    let score = 0;
    for (const t of optionTokens[i]) {
      let appearsElsewhere = false;
      for (let j = 0; j < options.length; j += 1) {
        if (j === i) continue;
        if (optionTokens[j].has(t)) {
          appearsElsewhere = true;
          break;
        }
      }
      if (!appearsElsewhere && explanationTokens.has(t)) score += 1;
    }
    return score;
  });

  const correctScore = scores[correctIndex];
  for (let j = 0; j < scores.length; j += 1) {
    if (j === correctIndex) continue;
    if (scores[j] >= correctScore + SIG_TOKEN_MARGIN && scores[j] >= SIG_TOKEN_MIN_WIN_SCORE) {
      return true;
    }
  }
  return false;
};

const detectExplanationMismatch = (input: QuizIntegrityLintInput): boolean => {
  const { options, correctIndex, explanation } = input;
  if (!explanation || explanation.length < 10) return false;
  if (correctIndex < 0 || correctIndex >= options.length) return false;
  if (detectExplicitCiteMismatch({ explanation, correctIndex, optionCount: options.length })) return true;
  if (detectSignatureOverlapMismatch({ options, correctIndex, explanation })) return true;
  return false;
};

// ── Public API ────────────────────────────────────────────────

export const lintQuizIntegrity = (input: QuizIntegrityLintInput): QuizIntegrityLintResult => {
  const { options, correctIndex } = input;
  const reasons: string[] = [];

  // Degenerate input guards — same shape as `distractorLint`. Trivially-pass
  // on malformed input so the lint never errors out.
  if (!options || options.length < 2 || correctIndex < 0 || correctIndex >= options.length) {
    return { reasons };
  }

  if (detectDuplicates(options)) reasons.push('duplicate-options');
  if (detectTruncatedCorrect({ options, correctIndex })) reasons.push('truncated-correct');
  if (detectExplanationMismatch(input)) reasons.push('explanation-mismatch');

  return { reasons };
};
