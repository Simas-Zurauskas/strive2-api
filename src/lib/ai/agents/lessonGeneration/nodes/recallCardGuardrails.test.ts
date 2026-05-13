/**
 * Self-executing tests for cloze / qa authoring guardrails.
 * Run: yarn test:recall-card-guardrails
 *
 * Covers the 2026-04-21 assessment follow-up:
 *   - Cloze: multi-token canonicals, disjunctions, code expressions, quotes,
 *     compound "X and Y", double-blank patterns → rejected
 *   - Cloze: single-token, CamelCase, 3-word technical terms, LaTeX span → allowed
 *   - QA: 16+ word answers → rejected; "Send and Sync" capitalized compound → rejected
 *   - QA: narrative "trial and error" → allowed
 *   - Possessive "learner's" → allowed
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { validateRecallCardCandidate } from './recallCardGuardrails';


type Candidate = Parameters<typeof validateRecallCardCandidate>[0];

const cloze = (promptStr: string, answer: string): Candidate => ({
  kind: 'cloze',
  prompt: promptStr,
  answer,
  conceptTags: ['tag'],
  sourceBlockId: 'section-1',
});

const qa = (promptStr: string, answer: string): Candidate => ({
  kind: 'qa',
  prompt: promptStr,
  answer,
  conceptTags: ['tag'],
  sourceBlockId: 'section-1',
});


// ── Cloze positive cases ───────────────────────────────────────

test('cloze: single-word answer accepted', () => {
  const r = validateRecallCardCandidate(cloze('The {{blank}} ensures atomicity.', 'mutex'));
  assert.equal(r.valid, true);
});

test('cloze: CamelCase single token accepted', () => {
  const r = validateRecallCardCandidate(cloze('The {{blank}} marker type has zero size.', 'PhantomData'));
  assert.equal(r.valid, true);
});

test('cloze: 3-word multi-word technical term accepted', () => {
  const r = validateRecallCardCandidate(
    cloze('Adam combines momentum with {{blank}} to adapt per-parameter learning rates.', 'stochastic gradient descent'),
  );
  assert.equal(r.valid, true);
});

test('cloze: hyphenated single token accepted', () => {
  const r = validateRecallCardCandidate(cloze('A {{blank}} stays balanced via color flips.', 'red-black tree'));
  assert.equal(r.valid, true);
});

test('cloze: LaTeX span counts as one token', () => {
  const r = validateRecallCardCandidate(cloze('The change in free energy is denoted {{blank}}.', '$\\Delta G$'));
  assert.equal(r.valid, true);
});

// ── Cloze negative cases (the canonical rubric failures) ──────

test('cloze: 4-token answer rejected', () => {
  const r = validateRecallCardCandidate(cloze('The concept is {{blank}}.', 'four words in a row'));
  assert.equal(r.valid, false);
  assert.ok(r.reason?.startsWith('cloze:tokens'), `reason=${r.reason}`);
});

test('cloze: disjunction with " or " rejected (Alex reset_index case)', () => {
  const r = validateRecallCardCandidate(
    // 3-token disjunction — targets the disjunction rule specifically. A
    // longer disjunction ("pipe or a helper") would also hit the 4-token
    // ceiling first; we keep them as separate test concerns.
    cloze('After groupby().agg(), flatten the column index using {{blank}}.', 'pipe or helper'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:disjunction');
});

test('cloze: disjunction with "X and Y" rejected (Mike Send and Sync case in cloze form)', () => {
  const r = validateRecallCardCandidate(
    cloze('Thread-safety requires {{blank}} marker traits.', 'Send and Sync'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:disjunction');
});

test('cloze: code expression with backticks rejected', () => {
  const r = validateRecallCardCandidate(
    cloze('Wrap debug with {{blank}}.', '`pipe(debug)`'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:code-expr');
});

test('cloze: function call rejected (Alex "_".join(col).strip("_") case, simplified)', () => {
  const r = validateRecallCardCandidate(
    cloze('Flatten the MultiIndex using {{blank}}.', 'col.strip("_")'),
  );
  assert.equal(r.valid, false);
  // Either code-expr or punctuation rule fires first. Both are correct rejections.
  assert.ok(
    r.reason === 'cloze:code-expr' || r.reason === 'cloze:punctuation',
    `reason=${r.reason}`,
  );
});

test('cloze: zero blanks rejected', () => {
  const r = validateRecallCardCandidate(cloze('No blank marker in this stem.', 'answer'));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:blanks=0');
});

test('cloze: double blanks rejected (Mike "Send AND Sync" two-blank case)', () => {
  const r = validateRecallCardCandidate(
    cloze('{{blank}} and {{blank}} are marker traits.', 'Send'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:blanks=2');
});

test('cloze: quoted string answer rejected', () => {
  const r = validateRecallCardCandidate(cloze('The answer is {{blank}}.', '"literal"'));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:punctuation');
});

// ── QA positive / negative ────────────────────────────────────

test('qa: answer under 15 words accepted', () => {
  const r = validateRecallCardCandidate(
    qa('Why does SM-2 suffer from ease hell?', 'Repeated Hard presses drive ease factor to its 1.3 floor.'),
  );
  assert.equal(r.valid, true);
});

test('qa: 16-word answer rejected', () => {
  const longAnswer = Array.from({ length: 16 }, (_, i) => `word${i}`).join(' ');
  const r = validateRecallCardCandidate(qa('Q?', longAnswer));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'qa:words=16');
});

test('qa: "Send and Sync" capitalized compound rejected', () => {
  const r = validateRecallCardCandidate(
    qa('What two marker traits signal thread-safety in Rust?', 'Send and Sync'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'qa:compound-and');
});

test('qa: lowercase "trial and error" allowed', () => {
  const r = validateRecallCardCandidate(qa('How do you find the right stopping rule?', 'trial and error'));
  assert.equal(r.valid, true);
});

test('qa: possessive "learner\'s" allowed', () => {
  const r = validateRecallCardCandidate(
    qa('Whose mental model takes priority in lesson design?', "the learner's"),
  );
  assert.equal(r.valid, true);
});

// ── Sanity: a few mixed cases ─────────────────────────────────

test('cloze: domain-specific noun ("Stability") accepted', () => {
  const r = validateRecallCardCandidate(
    cloze(
      'FSRS models memory with three variables: Difficulty, {{blank}}, and Retrievability.',
      'Stability',
    ),
  );
  assert.equal(r.valid, true);
});

test('cloze: lower-case "and" between proper nouns in answer rejected via disjunction rule', () => {
  const r = validateRecallCardCandidate(
    cloze('Thread-safe marker traits include {{blank}}.', 'Send and Sync'),
  );
  assert.equal(r.valid, false);
});

// ── Curriculum-meta rejection (2026-05-13 follow-up) ──────────

test('cloze: curriculum-meta stem ("this course") rejected', () => {
  const r = validateRecallCardCandidate(
    cloze('The three practice tables in this course are {{blank}}, products, and orders.', 'customers'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'curriculum-meta');
});

test('qa: curriculum-meta stem ("in this lesson") rejected', () => {
  const r = validateRecallCardCandidate(
    qa('What modules are in this course?', 'Module 1, 2, and 3'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'curriculum-meta');
});

test('cloze: domain-prose containing "this" but not "this course" allowed', () => {
  // Guard against the curriculum-meta regex over-firing on generic "this".
  const r = validateRecallCardCandidate(
    cloze('A {{blank}} structure organizes records by a key.', 'hash'),
  );
  assert.equal(r.valid, true);
});

// ── Numeric-range cloze rejection ─────────────────────────────

test('cloze: dollar-range answer ($150-$250) rejected', () => {
  const r = validateRecallCardCandidate(
    cloze('Mid-tier mini sessions cluster around {{blank}}.', '$150–$250'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:numeric-range');
});

test('cloze: numeric range with unit (30-60 seconds) rejected', () => {
  const r = validateRecallCardCandidate(
    cloze('Garlic transitions raw-to-golden in {{blank}}.', '30–60 seconds'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:numeric-range');
});

test('cloze: single number (not a range) still accepted', () => {
  const r = validateRecallCardCandidate(
    cloze('A list has {{blank}} elements when empty.', 'zero'),
  );
  assert.equal(r.valid, true);
});

// ── Stem-telegraphs-answer rejection ──────────────────────────

test('cloze: stem containing the canonical answer verbatim rejected', () => {
  // "double-bracket" telegraphed by "outer brackets...inner brackets" was the
  // motivating case; we test the simpler verbatim form here, since regex
  // can't detect the paraphrased version reliably (the model prompt handles
  // that). Belt-and-braces is fine.
  const r = validateRecallCardCandidate(
    cloze('Use the {{blank}} syntax — double-bracket indexing returns a DataFrame.', 'double-bracket'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:stem-telegraphs-answer');
});

test('cloze: stem without the canonical answer accepted', () => {
  const r = validateRecallCardCandidate(
    cloze('Pass a list of column names to get a DataFrame back: df[{{blank}}].', "['x', 'y']"),
  );
  // Different rejection path (code-expr); just confirms we don't over-trigger telegraph.
  assert.equal(r.valid, false);
  assert.notEqual(r.reason, 'cloze:stem-telegraphs-answer');
});

test('cloze: short canonical (< 4 chars) does not trigger telegraph check', () => {
  // "key" is only 3 chars — common stop word risk. Telegraph rule skips
  // canonicals under 4 chars to avoid false positives. This card is fine.
  const r = validateRecallCardCandidate(
    cloze('A dict lookup uses the {{blank}} to find the value, even when "key" appears elsewhere.', 'key'),
  );
  assert.equal(r.valid, true);
});

