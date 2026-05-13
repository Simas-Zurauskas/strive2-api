/**
 * Self-executing tests for lintDistractors.
 * Run: yarn test:distractor-lint
 *
 * Covers the three deterministic heuristics that defend against skim-gaming:
 *   - length uniformity (correct within ±30% of median)
 *   - correct is not strictly longest (tied-for-longest is OK)
 *   - absolute qualifiers in distractors only when correct also uses one
 *
 * Also tests degenerate-input guards.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { lintDistractors, repairDistractors } from './distractorLint';



// ── Length uniformity ─────────────────────────────────────────

test('options within ±30% of median length → lengthOk', () => {
  const r = lintDistractors({
    options: ['aperture controls depth', 'shutter controls motion', 'ISO controls sensor gain', 'focus controls sharpness'],
    correctIndex: 0,
  });
  assert.equal(r.lengthOk, true, `reasons=${r.reasons.join(',')}`);
});

test('one option far outside ±30% → lengthOk false', () => {
  const r = lintDistractors({
    options: ['short one', 'short two', 'an extraordinarily lengthy option string pushing outside the band', 'short three'],
    correctIndex: 1,
  });
  assert.equal(r.lengthOk, false);
  assert.ok(r.reasons.includes('length-uniformity'));
});

// ── Correct-is-not-strictly-longest ───────────────────────────

test('correct is strictly longest → correctNotLongest false', () => {
  const r = lintDistractors({
    options: ['A', 'B', 'C', 'The correct answer is this one because of extra context'],
    correctIndex: 3,
  });
  assert.equal(r.correctNotLongest, false);
  assert.ok(r.reasons.includes('correct-is-longest'));
});

test('correct is tied-for-longest → correctNotLongest true (can\'t pick-longest your way in)', () => {
  const r = lintDistractors({
    options: ['abcdefg same', 'abcdefg same', 'abcdefg same', 'abcdefg same'],
    correctIndex: 2,
  });
  assert.equal(r.correctNotLongest, true);
});

test('correct is median length → correctNotLongest true', () => {
  const r = lintDistractors({
    options: ['short', 'ten chars!', 'medium one', 'a longer distractor here'],
    correctIndex: 1,
  });
  assert.equal(r.correctNotLongest, true);
});

// ── Absolute qualifier discipline ─────────────────────────────

test('distractor has "never", correct has none → absoluteQualifierOk false', () => {
  const r = lintDistractors({
    options: [
      'aperture affects depth of field',
      'aperture never affects depth of field',
      'aperture only affects exposure time',
      'aperture changes shutter speed',
    ],
    correctIndex: 0,
  });
  assert.equal(r.absoluteQualifierOk, false);
  assert.ok(r.reasons.includes('distractor-absolute-qualifier'));
});

test('correct also uses "always" → permitted in distractors', () => {
  const r = lintDistractors({
    options: [
      'a wide aperture always reduces depth of field',
      'a wide aperture never reduces depth of field',
      'a wide aperture sometimes reduces depth',
      'a wide aperture lengthens shutter',
    ],
    correctIndex: 0,
  });
  assert.equal(r.absoluteQualifierOk, true);
});

test('no absolute qualifiers anywhere → absoluteQualifierOk true', () => {
  const r = lintDistractors({
    options: ['one', 'two', 'three', 'four'],
    correctIndex: 2,
  });
  assert.equal(r.absoluteQualifierOk, true);
});

// ── Reasons aggregation ───────────────────────────────────────

test('multiple failures populate multiple reasons', () => {
  const r = lintDistractors({
    options: [
      'a',
      'a',
      'a',
      'very long correct answer that only gets picked because it is the only one with detail',
    ],
    correctIndex: 3,
  });
  assert.ok(r.reasons.includes('length-uniformity'));
  assert.ok(r.reasons.includes('correct-is-longest'));
});

// ── Degenerate input guards ───────────────────────────────────

test('< 2 options returns trivial-pass', () => {
  const r = lintDistractors({ options: ['only one'], correctIndex: 0 });
  assert.deepEqual(r.reasons, []);
});

test('out-of-bounds correctIndex returns trivial-pass', () => {
  const r = lintDistractors({ options: ['a', 'b'], correctIndex: 5 });
  assert.deepEqual(r.reasons, []);
});

// ── repairDistractors ──────────────────────────────────────────

test('repair: already-clean input returns changed=false', () => {
  const r = repairDistractors({
    options: ['aperture controls depth', 'shutter controls motion', 'ISO controls sensor gain', 'focus controls sharpness'],
    correctIndex: 0,
  });
  assert.equal(r.changed, false);
  assert.deepEqual(r.appliedRepairs, []);
  assert.deepEqual(r.options[0], 'aperture controls depth');
});

test('repair: hedges absolute qualifiers in distractors only, leaves correct untouched', () => {
  const input = {
    options: [
      'aperture affects depth of field',
      'aperture never affects depth of field',
      'aperture only affects exposure time',
      'aperture always lengthens shutter',
    ],
    correctIndex: 0,
  };
  const r = repairDistractors(input);
  assert.equal(r.changed, true);
  assert.ok(r.appliedRepairs.includes('absolute-qualifier'));
  assert.equal(r.options[0], 'aperture affects depth of field', 'correct answer untouched');
  assert.equal(r.options[1], 'aperture rarely affects depth of field');
  assert.equal(r.options[2], 'aperture mainly affects exposure time');
  assert.equal(r.options[3], 'aperture typically lengthens shutter');
  // Linter must now pass.
  const postLint = lintDistractors({ options: r.options, correctIndex: r.correctIndex });
  assert.ok(!postLint.reasons.includes('distractor-absolute-qualifier'));
});

test('repair: does NOT hedge when correct answer also uses an absolute', () => {
  const input = {
    options: [
      'a wide aperture always reduces depth of field',
      'a wide aperture never reduces depth of field',
      'a wide aperture only increases exposure',
      'a wide aperture lengthens shutter',
    ],
    correctIndex: 0,
  };
  const r = repairDistractors(input);
  // Already passing the absolute-qualifier rule → no hedge applied.
  assert.ok(!r.appliedRepairs.includes('absolute-qualifier'));
  assert.equal(r.options[1], 'a wide aperture never reduces depth of field', 'distractor untouched when rule passes');
});

test('repair: trims em-dash justification from correct answer', () => {
  const input = {
    options: [
      'returns a reference',
      'returns a copy',
      'returns undefined',
      'returns a value — immutable by default and pass-by-value semantics apply throughout',
    ],
    correctIndex: 3,
  };
  const pre = lintDistractors({ options: input.options, correctIndex: input.correctIndex });
  assert.ok(pre.reasons.includes('correct-is-longest'), 'precondition: correct is longest');

  const r = repairDistractors(input);
  assert.equal(r.changed, true);
  assert.ok(r.appliedRepairs.includes('correct-tail-trim'));
  assert.equal(r.options[3], 'returns a value');
  const post = lintDistractors({ options: r.options, correctIndex: r.correctIndex });
  assert.ok(!post.reasons.includes('correct-is-longest'));
});

test('repair: trims `because` clause when em-dash not present', () => {
  const input = {
    options: [
      'closures capture enclosing scope and variables',
      'scope chains resolve through prototype lookups',
      'the function captures variables, because closures are first-class objects in JavaScript',
      'prototypes delegate missing property lookups',
    ],
    correctIndex: 2,
  };
  const pre = lintDistractors({ options: input.options, correctIndex: input.correctIndex });
  assert.ok(pre.reasons.includes('correct-is-longest'), 'precondition: correct is longest');

  const r = repairDistractors(input);
  assert.ok(r.appliedRepairs.includes('correct-tail-trim'));
  assert.equal(r.options[2], 'the function captures variables');
});

test('repair: gives up gracefully when no trim helps (correct remains longest)', () => {
  // No em-dash / because / semicolon / comma — nothing to cut.
  const input = {
    options: [
      'a',
      'b',
      'c',
      'thisoneisalongsingletokencorrectanswer',
    ],
    correctIndex: 3,
  };
  const r = repairDistractors(input);
  assert.equal(r.appliedRepairs.includes('correct-tail-trim'), false);
  // Options should be unchanged for this specific input.
  assert.equal(r.options[3], 'thisoneisalongsingletokencorrectanswer');
});

test('repair: fixes both rules together', () => {
  const input = {
    options: [
      'a short one',
      'this option always fails',
      'another short',
      'the correct answer — with a trailing justification that makes it the longest',
    ],
    correctIndex: 3,
  };
  const r = repairDistractors(input);
  assert.ok(r.appliedRepairs.includes('absolute-qualifier'));
  assert.ok(r.appliedRepairs.includes('correct-tail-trim'));
  assert.equal(r.options[1], 'this option typically fails');
  assert.equal(r.options[3], 'the correct answer');
});

test('repair: preserves leading capitalization when hedging', () => {
  const input = {
    options: [
      'the pattern holds',
      'Never pass a pointer',
      'the reference changes',
      'the value stays stable',
    ],
    correctIndex: 0,
  };
  const r = repairDistractors(input);
  assert.equal(r.options[1], 'Rarely pass a pointer');
});

test('repair: idempotent — second call makes no further change', () => {
  const input = {
    options: [
      'correct option',
      'this always holds',
      'another one',
      'fourth option',
    ],
    correctIndex: 0,
  };
  const first = repairDistractors(input);
  const second = repairDistractors({ options: first.options, correctIndex: first.correctIndex });
  assert.equal(second.changed, false);
  assert.deepEqual(second.options, first.options);
});

test('repair: degenerate input (out-of-bounds correctIndex) is a no-op', () => {
  const r = repairDistractors({ options: ['a', 'b'], correctIndex: 7 });
  assert.equal(r.changed, false);
  assert.deepEqual(r.appliedRepairs, []);
});

// ── Code-context skip (regression: --all-namespaces, header=None) ─

test('lint: CLI flag --all-namespaces does not trip absolute-qualifier rule', () => {
  const r = lintDistractors({
    options: [
      'Run kubectl get pods --all-namespaces to list across namespaces',
      'Run kubectl get pods -n default for the default namespace',
      'Run kubectl describe pods --namespace=kube-system',
      'Run kubectl logs --container=app to stream container logs',
    ],
    correctIndex: 0,
  });
  assert.equal(r.absoluteQualifierOk, true, `reasons=${r.reasons.join(',')}`);
});

test('repair: --all-namespaces in a distractor is preserved verbatim', () => {
  const input = {
    options: [
      'Use kubectl get pods to list pods in the current namespace',
      'Use kubectl get pods --all-namespaces in a distractor that fires the lint',
      'Use kubectl get pods always to skip namespace filter on a wide cluster',
      'Use kubectl get pods quietly',
    ],
    correctIndex: 0,
  };
  // Distractor at idx 2 has "always" (prose) → lint fires → hedge runs.
  // Distractor at idx 1 has "all" inside --all-namespaces → must NOT be hedged.
  const r = repairDistractors(input);
  assert.ok(r.appliedRepairs.includes('absolute-qualifier'));
  assert.match(r.options[1], /--all-namespaces/, 'CLI flag must survive hedging');
  assert.match(r.options[2], /typically to skip namespace/);
});

test('repair: header=None kwarg literal is preserved', () => {
  const input = {
    options: [
      'pd.read_csv(path, header=0) treats the first row as the header',
      'pd.read_csv(path, header=None) reads the file without a header row',
      'pd.read_csv(path, header=1) always skips the first row before parsing',
      'pd.read_csv(path, header="auto") infers the header position from content',
    ],
    correctIndex: 0,
  };
  // idx 2 has prose "always" → triggers lint. Repair must hedge idx 2 but
  // leave the `header=None` literal at idx 1 alone.
  const r = repairDistractors(input);
  assert.ok(r.appliedRepairs.includes('absolute-qualifier'));
  assert.match(r.options[1], /header=None/, 'kwarg literal must survive hedging');
  assert.match(r.options[2], /typically skips/);
});

test('repair: backticked `all` inside an inline-code span is preserved', () => {
  const input = {
    options: [
      'Pass the flag normally to opt in',
      'Pass `--all` to scan every directory',
      'Pass `--quiet` to always suppress logs',
      'Pass `--verbose` to stream every event',
    ],
    correctIndex: 0,
  };
  const r = repairDistractors(input);
  // idx 2 has prose "always" outside the backticks; idx 1 has `--all` inside.
  assert.ok(r.appliedRepairs.includes('absolute-qualifier'));
  assert.match(r.options[1], /`--all`/, 'backticked CLI flag must survive');
});

test('repair: prose "all Pods" without a CLI prefix is still hedged', () => {
  // Sanity check: the code-context guard must only skip TECHNICAL adjacency,
  // not regular prose containing "all". This is a distractor where "all"
  // is a real absolute qualifier, no `--`/`=`/etc. nearby.
  const input = {
    options: [
      'The controller reconciles one Pod at a time during the watch loop',
      'The controller reconciles all Pods on every tick of the scheduler',
      'The controller reconciles Pods only when the readiness probe fires',
      'The controller reconciles new Pods opportunistically with backoff',
    ],
    correctIndex: 0,
  };
  const r = repairDistractors(input);
  assert.ok(r.appliedRepairs.includes('absolute-qualifier'));
  assert.match(r.options[1], /most Pods/);
  assert.match(r.options[2], /mainly when/);
});

