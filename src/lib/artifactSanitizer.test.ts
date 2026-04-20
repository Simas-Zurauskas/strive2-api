/**
 * Self-executing test file for `artifactSanitizer`. Runs under `ts-node`
 * with no test framework (matches the zero-dep philosophy of lib/metrics).
 *
 * Run: yarn test:sanitizer
 *
 * Exits 0 on success; assertion failures throw and exit non-zero.
 */

import assert from 'node:assert/strict';
import { sanitizeArtifacts, ARTIFACT_PATTERNS } from './artifactSanitizer';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
};

console.log('artifactSanitizer');

// ── No-op + type-guard behaviour ──────────────────────────────

test('returns empty string unchanged', () => {
  const r = sanitizeArtifacts('');
  assert.equal(r.text, '');
  assert.equal(r.stripped, 0);
  assert.equal(r.gutted, false);
});

test('returns non-string input safely', () => {
  // @ts-expect-error — exercising runtime guard on bad input
  const r = sanitizeArtifacts(null);
  assert.equal(r.text, '');
  assert.equal(r.stripped, 0);
  assert.equal(r.gutted, false);
});

test('clean prose passes through unchanged', () => {
  const input = 'Flexbox arranges items along a main axis. Use flex-direction to change the axis.';
  const r = sanitizeArtifacts(input);
  assert.equal(r.text, input);
  assert.equal(r.stripped, 0);
  assert.equal(r.gutted, false);
});

// ── The exact chloe leak (the regression case) ───────────────

test('strips the chloe leak end-to-end and flags gutted', () => {
  const chloeLeak =
    "Actually: 4 \u00d7 200px = 800px \u2264 850px, so 4 columns fit. The answer should be 4 columns. Re-selecting correctIndex to 2 (the '4 columns' option) and updating the explanation accordingly.";
  const r = sanitizeArtifacts(chloeLeak);
  assert.ok(r.stripped >= 3, `expected >=3 strips, got ${r.stripped}`);
  assert.equal(r.gutted, true);
  // After the strip, text should not contain any of the seven meta-phrases
  assert.equal(/Re-?selecting correctIndex/i.test(r.text), false);
  assert.equal(/answer should be/i.test(r.text), false);
  assert.equal(/updating the explanation/i.test(r.text), false);
});

// ── Per-pattern positive + negative coverage ──────────────────

test('P1 reselecting_correctIndex — matches', () => {
  const r = sanitizeArtifacts('The concept is X. Re-selecting correctIndex to 1 for accuracy. More text here.');
  assert.equal(r.stripped, 1);
  assert.equal(/correctIndex/i.test(r.text), false);
});

test('P2 updating_explanation — matches', () => {
  const r = sanitizeArtifacts('updating the explanation accordingly.');
  assert.equal(r.stripped, 1);
});

test('P3 let_me_reconsider — matches all variants', () => {
  for (const phrase of ['Let me re-examine', 'Let me reconsider', 'Let me recheck', 'Let me double-check', 'Let me recalculate']) {
    const r = sanitizeArtifacts(`${phrase} this carefully.`);
    assert.equal(r.stripped, 1, `expected strip for "${phrase}"`);
  }
});

test('P3 does not match "re-examine your work" in teaching prose', () => {
  // No "Let me" prefix — must not match.
  const input = 'Re-examine your work and identify any bugs.';
  const r = sanitizeArtifacts(input);
  assert.equal(r.stripped, 0);
  assert.equal(r.text, input);
});

test('P4 answer_should_be — matches', () => {
  const r = sanitizeArtifacts('The correct answer should be option B based on the formula.');
  assert.equal(r.stripped, 1);
});

test('P4 does not match "the correct answer is X"', () => {
  const input = 'The correct answer is B because the formula requires a positive discriminant.';
  const r = sanitizeArtifacts(input);
  assert.equal(r.stripped, 0);
  assert.equal(r.text, input);
});

test('P5 i_should_pick — matches', () => {
  const r = sanitizeArtifacts('Given this, I should pick option A to be safe.');
  assert.equal(r.stripped, 1);
});

test('P5 does not match imperative "Select an option"', () => {
  const input = 'Select the option that minimises the cost.';
  const r = sanitizeArtifacts(input);
  assert.equal(r.stripped, 0);
  assert.equal(r.text, input);
});

test('P6 actually_arithmetic — matches', () => {
  const r = sanitizeArtifacts('Actually: 2 + 2 = 5, so the answer changes.');
  assert.equal(r.stripped, 1);
});

test('P6 does not match "actually" as adverb', () => {
  const input = 'Flexbox actually wraps items onto new lines when they overflow.';
  const r = sanitizeArtifacts(input);
  assert.equal(r.stripped, 0);
  assert.equal(r.text, input);
});

test('P6 does not match "Actually:" without arithmetic symbols', () => {
  const input = "Actually: it depends on context. The grammar matters.";
  const r = sanitizeArtifacts(input);
  assert.equal(r.stripped, 0);
  assert.equal(r.text, input);
});

test('P7 wait_backtrack — matches', () => {
  const r = sanitizeArtifacts("Wait, that's not right — let me redo the math.");
  assert.equal(r.stripped, 1);
});

test('P7 does not match "Wait for the page to load"', () => {
  const input = 'Wait for the page to load before clicking submit.';
  const r = sanitizeArtifacts(input);
  assert.equal(r.stripped, 0);
  assert.equal(r.text, input);
});

// ── Gutted detection ──────────────────────────────────────────

test('flags gutted when >60% stripped', () => {
  const input = 'Re-selecting correctIndex to 2.'; // ~100% meta-phrase
  const r = sanitizeArtifacts(input);
  assert.equal(r.gutted, true);
  assert.equal(r.text, '');
});

test('does not flag gutted when most of the text survives', () => {
  // ~30 chars of strip, ~200 chars of surviving prose → survival >> 40%.
  const input =
    'Flexbox is a one-dimensional layout model for distributing items across a row or column. ' +
    'It excels at handling dynamic content sizes and alignment. ' +
    'Let me reconsider that last point.';
  const r = sanitizeArtifacts(input);
  assert.equal(r.stripped, 1);
  assert.equal(r.gutted, false);
  assert.ok(r.text.length > 50);
});

// ── Multi-pattern + cleanup ───────────────────────────────────

test('strips multiple adjacent patterns in one pass', () => {
  const input = 'The correct answer should be B. Let me reconsider the options.';
  const r = sanitizeArtifacts(input);
  assert.equal(r.stripped, 2);
});

test('collapses leftover whitespace after strips', () => {
  const input = 'Introduction.   Let me reconsider this.   Conclusion.';
  const r = sanitizeArtifacts(input);
  assert.equal(r.stripped, 1);
  // Double-space around the strip should collapse to single-space.
  assert.equal(/ {2,}/.test(r.text), false);
});

test('idempotent: running twice equals running once', () => {
  const input =
    "Actually: 3 + 3 = 7, so four columns. Re-selecting correctIndex to 2. Flexbox arranges items along a main axis.";
  const once = sanitizeArtifacts(input);
  const twice = sanitizeArtifacts(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.stripped, 0);
});

test('preserves LaTeX math delimiters around stripped content', () => {
  // Artifact sanitizer runs AFTER latexSanitizer, but we still verify it
  // never damages $…$ spans (none of the patterns contain `$`).
  const input = 'The formula is $E = mc^2$. Let me reconsider the sign convention. Done.';
  const r = sanitizeArtifacts(input);
  assert.equal(/\$E = mc\^2\$/.test(r.text), true);
  assert.equal(r.stripped, 1);
});

test('constrains matches to a single line', () => {
  // Pattern bounds `[^.\n]*` must prevent a match crossing a newline.
  const input = "Let me reconsider\nThis next sentence is legitimate teaching prose.";
  const r = sanitizeArtifacts(input);
  // The first line strips; the second must survive.
  assert.equal(/legitimate teaching prose/.test(r.text), true);
});

// ── Pattern-registry self-check ───────────────────────────────

test('every ARTIFACT_PATTERN has a named id and global flag', () => {
  assert.ok(ARTIFACT_PATTERNS.length >= 7, 'expected at least 7 patterns');
  for (const { name, pattern } of ARTIFACT_PATTERNS) {
    assert.ok(name && name.length > 0, `pattern missing name`);
    assert.ok(pattern.flags.includes('g'), `pattern ${name} missing 'g' flag`);
    assert.ok(pattern.flags.includes('i'), `pattern ${name} missing 'i' flag`);
  }
});

console.log(`\n\u2713 artifactSanitizer: ${passed} test(s) passed`);
