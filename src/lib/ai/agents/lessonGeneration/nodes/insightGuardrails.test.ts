/**
 * Self-executing tests for cloze / qa authoring guardrails.
 * Run: yarn test:insight-guardrails
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
import { validateInsightCandidate } from './insightGuardrails';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
};

type Candidate = Parameters<typeof validateInsightCandidate>[0];

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

console.log('insightGeneration.validateInsightCandidate');

// ── Cloze positive cases ───────────────────────────────────────

test('cloze: single-word answer accepted', () => {
  const r = validateInsightCandidate(cloze('The {{blank}} ensures atomicity.', 'mutex'));
  assert.equal(r.valid, true);
});

test('cloze: CamelCase single token accepted', () => {
  const r = validateInsightCandidate(cloze('The {{blank}} marker type has zero size.', 'PhantomData'));
  assert.equal(r.valid, true);
});

test('cloze: 3-word multi-word technical term accepted', () => {
  const r = validateInsightCandidate(
    cloze('Adam combines momentum with {{blank}} to adapt per-parameter learning rates.', 'stochastic gradient descent'),
  );
  assert.equal(r.valid, true);
});

test('cloze: hyphenated single token accepted', () => {
  const r = validateInsightCandidate(cloze('A {{blank}} stays balanced via color flips.', 'red-black tree'));
  assert.equal(r.valid, true);
});

test('cloze: LaTeX span counts as one token', () => {
  const r = validateInsightCandidate(cloze('The change in free energy is denoted {{blank}}.', '$\\Delta G$'));
  assert.equal(r.valid, true);
});

// ── Cloze negative cases (the canonical rubric failures) ──────

test('cloze: 4-token answer rejected', () => {
  const r = validateInsightCandidate(cloze('The concept is {{blank}}.', 'four words in a row'));
  assert.equal(r.valid, false);
  assert.ok(r.reason?.startsWith('cloze:tokens'), `reason=${r.reason}`);
});

test('cloze: disjunction with " or " rejected (Alex reset_index case)', () => {
  const r = validateInsightCandidate(
    // 3-token disjunction — targets the disjunction rule specifically. A
    // longer disjunction ("pipe or a helper") would also hit the 4-token
    // ceiling first; we keep them as separate test concerns.
    cloze('After groupby().agg(), flatten the column index using {{blank}}.', 'pipe or helper'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:disjunction');
});

test('cloze: disjunction with "X and Y" rejected (Mike Send and Sync case in cloze form)', () => {
  const r = validateInsightCandidate(
    cloze('Thread-safety requires {{blank}} marker traits.', 'Send and Sync'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:disjunction');
});

test('cloze: code expression with backticks rejected', () => {
  const r = validateInsightCandidate(
    cloze('Wrap debug with {{blank}}.', '`pipe(debug)`'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:code-expr');
});

test('cloze: function call rejected (Alex "_".join(col).strip("_") case, simplified)', () => {
  const r = validateInsightCandidate(
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
  const r = validateInsightCandidate(cloze('No blank marker in this stem.', 'answer'));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:blanks=0');
});

test('cloze: double blanks rejected (Mike "Send AND Sync" two-blank case)', () => {
  const r = validateInsightCandidate(
    cloze('{{blank}} and {{blank}} are marker traits.', 'Send'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:blanks=2');
});

test('cloze: quoted string answer rejected', () => {
  const r = validateInsightCandidate(cloze('The answer is {{blank}}.', '"literal"'));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cloze:punctuation');
});

// ── QA positive / negative ────────────────────────────────────

test('qa: answer under 15 words accepted', () => {
  const r = validateInsightCandidate(
    qa('Why does SM-2 suffer from ease hell?', 'Repeated Hard presses drive ease factor to its 1.3 floor.'),
  );
  assert.equal(r.valid, true);
});

test('qa: 16-word answer rejected', () => {
  const longAnswer = Array.from({ length: 16 }, (_, i) => `word${i}`).join(' ');
  const r = validateInsightCandidate(qa('Q?', longAnswer));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'qa:words=16');
});

test('qa: "Send and Sync" capitalized compound rejected', () => {
  const r = validateInsightCandidate(
    qa('What two marker traits signal thread-safety in Rust?', 'Send and Sync'),
  );
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'qa:compound-and');
});

test('qa: lowercase "trial and error" allowed', () => {
  const r = validateInsightCandidate(qa('How do you find the right stopping rule?', 'trial and error'));
  assert.equal(r.valid, true);
});

test('qa: possessive "learner\'s" allowed', () => {
  const r = validateInsightCandidate(
    qa('Whose mental model takes priority in lesson design?', "the learner's"),
  );
  assert.equal(r.valid, true);
});

// ── Sanity: a few mixed cases ─────────────────────────────────

test('cloze: domain-specific noun ("Stability") accepted', () => {
  const r = validateInsightCandidate(
    cloze(
      'FSRS models memory with three variables: Difficulty, {{blank}}, and Retrievability.',
      'Stability',
    ),
  );
  assert.equal(r.valid, true);
});

test('cloze: lower-case "and" between proper nouns in answer rejected via disjunction rule', () => {
  const r = validateInsightCandidate(
    cloze('Thread-safe marker traits include {{blank}}.', 'Send and Sync'),
  );
  assert.equal(r.valid, false);
});

console.log(`\n${passed} passed`);
