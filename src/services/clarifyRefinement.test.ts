/**
 * Self-executing test file for the clarify-generation schema refinement +
 * `isThinFreeText` helper (Phase 2 of the 2026-04-20 assessment fixes).
 *
 * Run: yarn test:clarify-refine
 *
 * Exits 0 on success; assertion failures throw and exit non-zero.
 */

import assert from 'node:assert/strict';
import { clarifyOutputSchema, isThinFreeText } from './clarifyValidation';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
};

console.log('clarify refinement + isThinFreeText');

// ── Schema refinement (0 vs ≥1 text question) ────────────────

test('rejects a questions array with zero type="text"', () => {
  const input = {
    courseName: 'Test Course',
    questions: [
      { id: 'q1', question: 'Experience?', type: 'multiple_choice', options: ['Beginner', 'Intermediate', 'Advanced'] },
      { id: 'q2', question: 'Tools?', type: 'multiple_select', options: ['A', 'B', 'C'] },
    ],
  };
  const result = clarifyOutputSchema.safeParse(input);
  assert.equal(result.success, false);
  if (!result.success) {
    const combined = result.error.issues.map((i) => i.message).join(' | ');
    assert.ok(
      combined.includes('At least one clarify question must be type="text"'),
      `expected refinement message, got: ${combined}`,
    );
  }
});

test('accepts an array with exactly one type="text"', () => {
  const input = {
    courseName: 'Test Course',
    questions: [
      { id: 'q1', question: 'Experience?', type: 'multiple_choice', options: ['Beginner', 'Intermediate', 'Advanced'] },
      { id: 'q2', question: 'Project?', type: 'text', options: null },
    ],
  };
  const result = clarifyOutputSchema.safeParse(input);
  assert.equal(result.success, true, 'expected parse to succeed with 1 text question');
});

test('accepts multiple type="text" questions', () => {
  const input = {
    courseName: 'Test Course',
    questions: [
      { id: 'q1', question: 'Project?', type: 'text', options: null },
      { id: 'q2', question: 'Stakeholders?', type: 'text', options: null },
      { id: 'q3', question: 'Experience?', type: 'multiple_choice', options: ['Beginner', 'Intermediate', 'Advanced'] },
    ],
  };
  const result = clarifyOutputSchema.safeParse(input);
  assert.equal(result.success, true, 'expected parse to succeed with 2 text questions');
});

test('rejects empty questions array (refinement still trips)', () => {
  const input = {
    courseName: 'Test Course',
    questions: [],
  };
  const result = clarifyOutputSchema.safeParse(input);
  assert.equal(result.success, false);
});

test('accepts the refinement when input arrives as a stringified JSON array (jsonish path)', () => {
  // jsonish wraps the schema in a union with a string→JSON.parse branch.
  // The refinement must still apply after parsing the string variant.
  const input = {
    courseName: 'Test Course',
    questions: JSON.stringify([
      { id: 'q1', question: 'Project?', type: 'text', options: null },
    ]),
  };
  const result = clarifyOutputSchema.safeParse(input);
  assert.equal(result.success, true, 'jsonish string→parse + refinement should succeed');
});

test('rejects the refinement when stringified JSON has no text question', () => {
  const input = {
    courseName: 'Test Course',
    questions: JSON.stringify([
      { id: 'q1', question: 'Level?', type: 'multiple_choice', options: ['A', 'B', 'C'] },
    ]),
  };
  const result = clarifyOutputSchema.safeParse(input);
  assert.equal(result.success, false);
});

// ── isThinFreeText helper ────────────────────────────────────

test('flags 2-token answer "stop overspending" as thin', () => {
  assert.equal(isThinFreeText('stop overspending'), true);
});

test('flags 3-token answer "Analyzing customer data" as thin', () => {
  assert.equal(isThinFreeText('Analyzing customer data'), true);
});

test('does not flag longer answer as thin', () => {
  assert.equal(
    isThinFreeText('I want to build a fintech dashboard for small business owners who sell online'),
    false,
  );
});

test('flags 1-token "C++" as thin (accepted FP — conservative scope is safe)', () => {
  assert.equal(isThinFreeText('C++'), true);
});

test('does not flag empty string', () => {
  assert.equal(isThinFreeText(''), false);
});

test('does not flag whitespace-only', () => {
  assert.equal(isThinFreeText('   \t\n  '), false);
});

test('does not flag non-string input', () => {
  // @ts-expect-error — exercising runtime guard
  assert.equal(isThinFreeText(null), false);
  // @ts-expect-error — exercising runtime guard
  assert.equal(isThinFreeText(undefined), false);
  // @ts-expect-error — exercising runtime guard
  assert.equal(isThinFreeText(42), false);
});

test('handles leading/trailing whitespace correctly', () => {
  assert.equal(isThinFreeText('   stop overspending   '), true);
  assert.equal(
    isThinFreeText('   I want to build a fintech dashboard for small business owners who sell   '),
    false,
  );
});

test('handles a 4-token answer as not-thin (boundary case)', () => {
  assert.equal(isThinFreeText('build a fintech dashboard'), false);
});

test('handles a 3-token answer as thin (boundary case)', () => {
  assert.equal(isThinFreeText('build fintech dashboard'), true);
});

console.log(`\n\u2713 clarify refinement + isThinFreeText: ${passed} test(s) passed`);
