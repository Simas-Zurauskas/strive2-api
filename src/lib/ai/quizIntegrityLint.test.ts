/**
 * Self-executing tests for `lintQuizIntegrity`.
 * Run: yarn test src/lib/ai/quizIntegrityLint.test.ts
 *
 * Covers the three integrity heuristics introduced after the 2026-05-02
 * debug-orchestrator assessment surfaced grading-inversion defects in
 * Marcus-data-analyst's Module-1 quiz:
 *   - duplicate-options
 *   - truncated-correct
 *   - explanation-mismatch
 *
 * Each defect has at least one reproduction fixture from a real run plus
 * targeted false-positive guards (T/F questions, single-word numerics,
 * substring-not-duplicate distractors, homogeneous-token explanations).
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { lintQuizIntegrity } from './quizIntegrityLint';

// Helper: a long, generic explanation token-disjoint from any options. Used
// when a fixture wants to focus on duplicate / truncation defects without
// accidentally tripping the explanation-mismatch heuristic.
const NEUTRAL_EXPLANATION =
  'Reasoning context paragraph that intentionally avoids reusing distinctive vocabulary from any single option, so the integrity lint focuses purely on the structural defect under test.';

// ── Defect 1: duplicate options ───────────────────────────────

test('Marcus Q8 reproduction: two identical options → duplicate-options', () => {
  const r = lintQuizIntegrity({
    options: [
      'The query joins the campaigns and customers tables on customer_id and groups by week',
      'INNER JOIN tables on the foreign key',
      'INNER JOIN tables on the foreign key',
      'The query uses LEFT JOIN to preserve campaigns with no customer activity',
    ],
    correctIndex: 0,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(r.reasons.includes('duplicate-options'), `reasons=${r.reasons.join(',')}`);
});

test('whitespace-and-case variance still flagged as duplicate', () => {
  const r = lintQuizIntegrity({
    options: ['Plausible distractor one', '  Same Text  ', 'same text', 'Plausible distractor two'],
    correctIndex: 0,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(r.reasons.includes('duplicate-options'));
});

test('trailing period vs no trailing period normalized as duplicates', () => {
  const r = lintQuizIntegrity({
    options: [
      'Distractor one with extra context for length',
      'The cache stores joined data',
      'The cache stores joined data.',
      'Distractor two with extra context for length',
    ],
    correctIndex: 0,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(r.reasons.includes('duplicate-options'));
});

test('substring guard: distractor that contains another is NOT a duplicate', () => {
  const r = lintQuizIntegrity({
    options: [
      'INNER JOIN',
      'INNER JOIN with USING clause',
      'OUTER JOIN preserving the left table rows',
      'CROSS JOIN producing the cartesian product',
    ],
    correctIndex: 1,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(!r.reasons.includes('duplicate-options'), `reasons=${r.reasons.join(',')}`);
});

// ── Defect 2: truncated correct option ────────────────────────

test('Marcus Q1 reproduction: truncated SQL fragment → truncated-correct', () => {
  const r = lintQuizIntegrity({
    options: [
      "SELECT campaign_name AS 'Campaign'",
      'SELECT campaign_name AS Campaign, SUM(revenue) AS total_revenue FROM campaigns WHERE date_trunc = current_week GROUP BY campaign_name',
      'SELECT campaign_name AS Campaign, SUM(revenue) FROM campaigns GROUP BY campaign_name ORDER BY total_revenue DESC LIMIT 10;',
      'SELECT campaign_name AS Campaign, COUNT(*) AS leads, SUM(revenue) AS total FROM campaigns INNER JOIN leads ON c.id = l.cid;',
    ],
    correctIndex: 0,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(r.reasons.includes('truncated-correct'), `reasons=${r.reasons.join(',')}`);
});

test('trailing comma case → truncated-correct', () => {
  const r = lintQuizIntegrity({
    options: [
      'The query joins on customer_id, filters by date_range, and aggregates with SUM,',
      'The query reads from the campaigns fact table and joins to the customer dimension',
      'The query uses a window function partitioned by region with a 7-day lookback',
      'The query relies on a CTE that materializes the daily snapshot before joining',
    ],
    correctIndex: 0,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(r.reasons.includes('truncated-correct'), `reasons=${r.reasons.join(',')}`);
});

test('trailing conjunction case ("...AS") → truncated-correct', () => {
  const r = lintQuizIntegrity({
    options: [
      'SELECT campaign_name AS',
      'SELECT campaign_name AS Campaign, SUM(revenue) AS total_revenue FROM campaigns;',
      'SELECT campaign_name AS Campaign, COUNT(*) AS lead_count FROM leads GROUP BY 1;',
      'SELECT campaign_name AS Campaign, AVG(spend) AS avg_spend FROM campaigns ORDER BY 1;',
    ],
    correctIndex: 0,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(r.reasons.includes('truncated-correct'));
});

test('unbalanced quote case → truncated-correct', () => {
  const r = lintQuizIntegrity({
    options: [
      "WHERE status = 'active",
      "WHERE status = 'active' AND created_at >= current_date - interval '7 days';",
      "WHERE status IN ('active', 'pending') AND region = 'us-east';",
      "WHERE status != 'archived' AND last_seen >= now() - interval '30 days';",
    ],
    correctIndex: 0,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(r.reasons.includes('truncated-correct'), `reasons=${r.reasons.join(',')}`);
});

test('T/F false-positive guard: short answers among short peers → no truncated-correct', () => {
  const r = lintQuizIntegrity({
    options: ['True', 'False', 'Sometimes', 'Never'],
    correctIndex: 0,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(!r.reasons.includes('truncated-correct'), `reasons=${r.reasons.join(',')}`);
});

test('numeric false-positive guard: dollar amounts → no truncated-correct', () => {
  const r = lintQuizIntegrity({
    options: ['$2M', '$5M', '$50M', '$500M'],
    correctIndex: 1,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(!r.reasons.includes('truncated-correct'));
});

test('legitimately complete short correct option among long peers → no truncated-correct', () => {
  // Example: a one-word answer ("Idempotent") that's complete and correct,
  // surrounded by longer prose distractors. Length-ratio fires (single word
  // vs prose paragraphs), but trailing-character signal does NOT — properly
  // spelled word, no trailing comma/conjunction/SQL fragment, balanced
  // delimiters → AND gate prevents firing.
  const r = lintQuizIntegrity({
    options: [
      'Idempotent',
      'Operations that maintain referential integrity across distributed transactions',
      'Operations that batch writes for write-amplification reduction across regions',
      'Operations that rely on optimistic concurrency control with retries',
    ],
    correctIndex: 0,
    explanation: NEUTRAL_EXPLANATION,
  });
  assert.ok(!r.reasons.includes('truncated-correct'), `reasons=${r.reasons.join(',')}`);
});

// ── Defect 3: correctIndex ↔ explanation mismatch ─────────────

test('explicit textual cite: explanation says "Option B is correct" but correctIndex=2 → mismatch', () => {
  const r = lintQuizIntegrity({
    options: [
      'Variables are garbage collected immediately after the function returns',
      'The closure captures references to the variables in its lexical scope',
      'Functions copy enclosing variables into the closure at creation time',
      'The engine pins the entire call stack until the closure is garbage collected',
    ],
    correctIndex: 2,
    explanation: 'Option B is correct because closures capture references, not copies, of the variables in the enclosing lexical scope.',
  });
  assert.ok(r.reasons.includes('explanation-mismatch'), `reasons=${r.reasons.join(',')}`);
});

test('explicit textual cite: numeric variant ("answer 1 is correct") flagged on disagreement', () => {
  const r = lintQuizIntegrity({
    options: [
      'Closures capture lexical references',
      'Closures store deep value copies',
      'Closures cache their return values',
      'Closures intern primitive values',
    ],
    correctIndex: 2,
    explanation: 'Answer 1 is correct because the closure binds to the variable identifier in scope, not to a snapshot of its value.',
  });
  assert.ok(r.reasons.includes('explanation-mismatch'));
});

test('explicit textual cite agrees with correctIndex → no mismatch', () => {
  const r = lintQuizIntegrity({
    options: [
      'Closures capture lexical references',
      'Closures store deep value copies',
      'Closures cache their return values',
      'Closures intern primitive values',
    ],
    correctIndex: 0,
    explanation: 'Option A is correct because closures bind to the variable identifier and the GC keeps that scope reachable.',
  });
  assert.ok(!r.reasons.includes('explanation-mismatch'), `reasons=${r.reasons.join(',')}`);
});

test('signature-token overlap: explanation tokens align with peer not correct → mismatch', () => {
  // Each option ≥ 40 chars (Path 2 precondition). Distinctive tokens per
  // option. Explanation reuses tokens unique to option 1 ("operational",
  // "transformation", "real-time", "edits"). correctIndex is wrongly set
  // to 0. Margin is ≥ 2 tokens.
  const r = lintQuizIntegrity({
    options: [
      'Cache-aside pattern with explicit invalidation on database writes propagating',
      'Operational transformation handles real-time concurrent edits across users',
      'Materialized views recompute on a schedule independent of source mutations',
      'Optimistic concurrency control retries on version-mismatch conflicts',
    ],
    correctIndex: 0,
    explanation: 'The right approach is operational transformation, which handles real-time edits from concurrent users by transforming each edit relative to the others.',
  });
  assert.ok(r.reasons.includes('explanation-mismatch'), `reasons=${r.reasons.join(',')}`);
});

test('homogeneous-overlap guard: shared tokens across options → no mismatch even when explanation mentions them', () => {
  // All four options describe variations of "WHERE clause filtering". Their
  // tokens overlap heavily, so unique_i is empty for each option and all
  // scores are 0. The margin gate (score ≥ 2) prevents firing.
  const r = lintQuizIntegrity({
    options: [
      'WHERE clause filtering rows by predicate before grouping aggregation',
      'WHERE clause filtering rows on indexed columns for performance',
      'WHERE clause filtering rows after the join executes for correctness',
      'WHERE clause filtering rows using parameterized predicates against injection',
    ],
    correctIndex: 0,
    explanation: 'WHERE clause filtering happens before grouping, which is why aggregates run on filtered rows.',
  });
  assert.ok(!r.reasons.includes('explanation-mismatch'), `reasons=${r.reasons.join(',')}`);
});

test('margin-gate guard: argmax only 1 token above correctIndex → no mismatch', () => {
  // Hand-crafted so the highest-scoring non-correct option exceeds correct
  // by exactly 1 unique token in the explanation — below the +2 margin gate.
  const r = lintQuizIntegrity({
    options: [
      'The closure captures lexical references that the garbage collector keeps reachable',
      'The engine inlines closure bodies to avoid the heap allocation entirely',
      'The runtime serializes closures into a continuation-passing form transparently',
      'Closures box their captured variables onto the stack frame for the activation',
    ],
    correctIndex: 0,
    // "lexical" appears uniquely in option 0; "captures" appears uniquely in
    // option 0; "inlines" + "heap" appear uniquely in option 1. Option 0's
    // unique-in-explanation count should be ≥ option 1's.
    explanation: 'The closure captures lexical references, and the garbage collector keeps the captured scope reachable for as long as the closure is alive.',
  });
  assert.ok(!r.reasons.includes('explanation-mismatch'), `reasons=${r.reasons.join(',')}`);
});

test('short-options guard: all options < 40 chars → Path 2 skipped', () => {
  // Path 2 (token overlap) is skipped because at least one option is short.
  // Path 1 (textual cite) still runs but no cite is present, so no flag.
  const r = lintQuizIntegrity({
    options: ['True', 'False', 'Maybe', 'Unknown'],
    correctIndex: 0,
    explanation: 'False is the right answer because the predicate evaluates as never being satisfied under the constraint.',
  });
  assert.ok(!r.reasons.includes('explanation-mismatch'));
});

// ── Multi-defect ──────────────────────────────────────────────

test('multi-defect: duplicate AND mismatch in same question populates both reasons', () => {
  const r = lintQuizIntegrity({
    options: [
      'Cache-aside pattern with explicit invalidation propagating writes downstream',
      'Operational transformation handles real-time concurrent edits across users',
      'Cache-aside pattern with explicit invalidation propagating writes downstream',
      'Optimistic concurrency control retries on version-mismatch conflicts',
    ],
    correctIndex: 0,
    explanation: 'Option B is correct because operational transformation handles real-time concurrent edits.',
  });
  assert.ok(r.reasons.includes('duplicate-options'));
  assert.ok(r.reasons.includes('explanation-mismatch'));
});

test('clean fixture: no defects → empty reasons', () => {
  const r = lintQuizIntegrity({
    options: [
      'The closure captures references to the variables in its lexical scope',
      'Functions copy enclosing variables into the closure at creation time',
      'The engine pins the entire call stack until the closure is garbage collected',
      'Variables are garbage collected immediately after the function returns',
    ],
    correctIndex: 0,
    explanation: 'Closures retain access because they hold references to the variables in lexical scope, which the garbage collector keeps alive while the closure is reachable.',
  });
  assert.deepEqual(r.reasons, []);
});

// ── Degenerate input ──────────────────────────────────────────

test('< 2 options returns trivial-pass', () => {
  const r = lintQuizIntegrity({
    options: ['only one'],
    correctIndex: 0,
    explanation: 'something',
  });
  assert.deepEqual(r.reasons, []);
});

test('out-of-bounds correctIndex returns trivial-pass', () => {
  const r = lintQuizIntegrity({
    options: ['a', 'b', 'c', 'd'],
    correctIndex: 5,
    explanation: 'something',
  });
  assert.deepEqual(r.reasons, []);
});

test('empty explanation skips mismatch check', () => {
  const r = lintQuizIntegrity({
    options: [
      'The closure captures references to the variables in its lexical scope',
      'Functions copy enclosing variables into the closure at creation time',
      'The engine pins the entire call stack until the closure is garbage collected',
      'Variables are garbage collected immediately after the function returns',
    ],
    correctIndex: 0,
    explanation: '',
  });
  assert.ok(!r.reasons.includes('explanation-mismatch'));
});
