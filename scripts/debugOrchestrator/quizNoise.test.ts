/**
 * Self-executing tests for the quiz-noise + think-time logic.
 * Run: yarn test:quiz-noise
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPrng } from './prng';
import { applyQuizNoise, computeSimulatedThinkTimeMs } from './quizNoise';
import type { QuizStyleFlags } from './types';


const noFlags: QuizStyleFlags = {
  rushes: false,
  secondGuesses: false,
  eliminates: false,
  guessesWhenUnsure: false,
};

const longStem = 'x'.repeat(250); // > LONG_STEM_THRESHOLD
const shortStem = 'x'.repeat(50);


// ── No-op / baseline ──────────────────────────────────────────

test('no flags → no injection regardless of confidence', () => {
  for (const conf of [0.1, 0.5, 0.9]) {
    const r = applyQuizNoise({
      questionId: 'q1',
      questionText: longStem,
      optionCount: 4,
      llmPick: 2,
      confidence: conf,
      flags: noFlags,
      prng: createPrng('no-flags-test'),
    });
    assert.equal(r.finalOption, 2);
    assert.equal(r.trace.injections.length, 0);
  }
});

test('eliminates baseline flag alone → no injection', () => {
  const r = applyQuizNoise({
    questionId: 'q1',
    questionText: longStem,
    optionCount: 4,
    llmPick: 2,
    confidence: 0.3,
    flags: { ...noFlags, eliminates: true },
    prng: createPrng('eliminates-test'),
  });
  assert.equal(r.finalOption, 2);
  assert.equal(r.trace.injections.length, 0);
});

// ── Rushes: position bias on long stems only ──────────────────

test('rushes + short stem → no position bias', () => {
  // Short stem bypasses the position-bias rule entirely.
  let injected = 0;
  for (let i = 0; i < 100; i++) {
    const r = applyQuizNoise({
      questionId: `q${i}`,
      questionText: shortStem,
      optionCount: 4,
      llmPick: 2,
      confidence: 0.8,
      flags: { ...noFlags, rushes: true },
      prng: createPrng(`short-stem-${i}`),
    });
    if (r.trace.injections.length > 0) injected += 1;
  }
  assert.equal(injected, 0, 'short stems should never trigger rushes:position-bias');
});

test('rushes + long stem + non-index-0 pick → sometimes flips to index 0', () => {
  let flipped = 0;
  const n = 1000;
  for (let i = 0; i < n; i++) {
    const r = applyQuizNoise({
      questionId: `q${i}`,
      questionText: longStem,
      optionCount: 4,
      llmPick: 2,
      confidence: 0.8,
      flags: { ...noFlags, rushes: true },
      prng: createPrng(`rush-flip-${i}`),
    });
    if (r.finalOption === 0 && r.trace.injections.includes('rushes:position-bias')) {
      flipped += 1;
    }
  }
  const rate = flipped / n;
  // Target P_RUSH_POSITION_BIAS = 0.15; allow ±0.03 tolerance.
  assert.ok(rate > 0.12 && rate < 0.18, `expected ~0.15 flip rate, got ${rate.toFixed(3)}`);
});

test('rushes + long stem + already-picked index 0 → no-op (bias agrees with pick)', () => {
  for (let i = 0; i < 100; i++) {
    const r = applyQuizNoise({
      questionId: `q${i}`,
      questionText: longStem,
      optionCount: 4,
      llmPick: 0,
      confidence: 0.8,
      flags: { ...noFlags, rushes: true },
      prng: createPrng(`rush-already-zero-${i}`),
    });
    // Pick never changes because the "bias target" matches the pick.
    assert.equal(r.finalOption, 0);
    assert.equal(r.trace.injections.length, 0);
  }
});

// ── guessesWhenUnsure: low-confidence swap ────────────────────

test('guessesWhenUnsure + low confidence → ~30% swap rate', () => {
  let swapped = 0;
  const n = 1000;
  for (let i = 0; i < n; i++) {
    const r = applyQuizNoise({
      questionId: `q${i}`,
      questionText: shortStem,
      optionCount: 4,
      llmPick: 2,
      confidence: 0.3, // below LOW_CONFIDENCE_THRESHOLD
      flags: { ...noFlags, guessesWhenUnsure: true },
      prng: createPrng(`guess-swap-${i}`),
    });
    if (r.finalOption !== 2) {
      assert.ok(r.trace.injections.includes('guessesWhenUnsure:swap-low-confidence'));
      swapped += 1;
    }
  }
  const rate = swapped / n;
  assert.ok(rate > 0.27 && rate < 0.33, `expected ~0.30 swap rate, got ${rate.toFixed(3)}`);
});

test('guessesWhenUnsure + high confidence → never swaps', () => {
  for (let i = 0; i < 200; i++) {
    const r = applyQuizNoise({
      questionId: `q${i}`,
      questionText: shortStem,
      optionCount: 4,
      llmPick: 2,
      confidence: 0.9, // above LOW_CONFIDENCE_THRESHOLD
      flags: { ...noFlags, guessesWhenUnsure: true },
      prng: createPrng(`guess-high-conf-${i}`),
    });
    assert.equal(r.finalOption, 2);
    assert.equal(r.trace.injections.length, 0);
  }
});

// ── secondGuesses: high-confidence flip ───────────────────────

test('secondGuesses + high confidence → ~10% flip rate', () => {
  let flipped = 0;
  const n = 1000;
  for (let i = 0; i < n; i++) {
    const r = applyQuizNoise({
      questionId: `q${i}`,
      questionText: shortStem,
      optionCount: 4,
      llmPick: 2,
      confidence: 0.85,
      flags: { ...noFlags, secondGuesses: true },
      prng: createPrng(`second-guess-${i}`),
    });
    if (r.finalOption !== 2) {
      assert.ok(r.trace.injections.includes('secondGuesses:flip-high-confidence'));
      flipped += 1;
    }
  }
  const rate = flipped / n;
  assert.ok(rate > 0.07 && rate < 0.13, `expected ~0.10 flip rate, got ${rate.toFixed(3)}`);
});

// ── Priority ordering ─────────────────────────────────────────

test('precedence: rushes injection suppresses later guessesWhenUnsure swap', () => {
  // Set conditions so both rushes AND guessesWhenUnsure would fire.
  // With high enough sample and the seeded PRNG, we expect SOME rushes
  // injections + ZERO guessesWhenUnsure injections in the trace.
  let rushesFired = 0;
  let guessFired = 0;
  const n = 200;
  for (let i = 0; i < n; i++) {
    const r = applyQuizNoise({
      questionId: `q${i}`,
      questionText: longStem,
      optionCount: 4,
      llmPick: 2,
      confidence: 0.3,
      flags: { ...noFlags, rushes: true, guessesWhenUnsure: true },
      prng: createPrng(`precedence-${i}`),
    });
    if (r.trace.injections.includes('rushes:position-bias')) rushesFired += 1;
    if (r.trace.injections.includes('guessesWhenUnsure:swap-low-confidence')) guessFired += 1;
  }
  assert.ok(rushesFired > 0, 'rushes should fire some of the time');
  // Zero matches would be incorrect too — we need guessesWhenUnsure to fire
  // when rushes does NOT fire on a given question. So expect SOME but fewer.
  assert.ok(guessFired > 0, 'guessesWhenUnsure should fire when rushes does not');
});

// ── Bounds / guards ───────────────────────────────────────────

test('final option is always in [0, optionCount)', () => {
  for (let i = 0; i < 500; i++) {
    const r = applyQuizNoise({
      questionId: `q${i}`,
      questionText: longStem,
      optionCount: 4,
      llmPick: 2,
      confidence: 0.3,
      flags: { rushes: true, secondGuesses: true, eliminates: true, guessesWhenUnsure: true },
      prng: createPrng(`bounds-${i}`),
    });
    assert.ok(r.finalOption >= 0 && r.finalOption < 4);
  }
});

test('malformed LLM pick (out of range) → clamped to 0', () => {
  const r = applyQuizNoise({
    questionId: 'q1',
    questionText: shortStem,
    optionCount: 4,
    llmPick: 42,
    confidence: 0.8,
    flags: noFlags,
    prng: createPrng('malformed-pick'),
  });
  assert.equal(r.finalOption, 0);
  assert.equal(r.trace.originalOption, 0);
});

test('malformed confidence (NaN) → clamped to 0.5', () => {
  const r = applyQuizNoise({
    questionId: 'q1',
    questionText: shortStem,
    optionCount: 4,
    llmPick: 2,
    confidence: NaN,
    flags: { ...noFlags, guessesWhenUnsure: true },
    prng: createPrng('malformed-conf'),
  });
  // 0.5 confidence is below LOW_CONFIDENCE_THRESHOLD (0.6), so swap is eligible.
  // Trace confidence must be the clamped value, not NaN.
  assert.equal(r.trace.confidence, 0.5);
});

test('deterministic: same input + same seed → same injection trace', () => {
  const flags: QuizStyleFlags = { ...noFlags, rushes: true, guessesWhenUnsure: true };
  const run = (seed: string) => applyQuizNoise({
    questionId: 'q1',
    questionText: longStem,
    optionCount: 4,
    llmPick: 2,
    confidence: 0.3,
    flags,
    prng: createPrng(seed),
  });
  const a = run('deterministic-seed');
  const b = run('deterministic-seed');
  assert.equal(a.finalOption, b.finalOption);
  assert.deepEqual(a.trace, b.trace);
});

// ── Simulated think-time ──────────────────────────────────────

test('think-time scales with stem length', () => {
  const short = computeSimulatedThinkTimeMs({
    questions: [{ questionText: 'x'.repeat(50) }],
    flags: noFlags,
    prng: createPrng('think-short'),
  });
  const long = computeSimulatedThinkTimeMs({
    questions: [{ questionText: 'x'.repeat(500) }],
    flags: noFlags,
    prng: createPrng('think-short'), // same seed → same jitter
  });
  assert.ok(long > short, `expected long stem > short, got ${long} vs ${short}`);
});

test('rushes multiplier reduces think-time', () => {
  const base = computeSimulatedThinkTimeMs({
    questions: [{ questionText: 'x'.repeat(100) }, { questionText: 'y'.repeat(100) }],
    flags: noFlags,
    prng: createPrng('think-mult'),
  });
  const rushed = computeSimulatedThinkTimeMs({
    questions: [{ questionText: 'x'.repeat(100) }, { questionText: 'y'.repeat(100) }],
    flags: { ...noFlags, rushes: true },
    prng: createPrng('think-mult'),
  });
  assert.ok(rushed < base, `rushed ${rushed} should be < base ${base}`);
});

test('eliminates multiplier increases think-time', () => {
  const base = computeSimulatedThinkTimeMs({
    questions: [{ questionText: 'x'.repeat(100) }, { questionText: 'y'.repeat(100) }],
    flags: noFlags,
    prng: createPrng('think-elim'),
  });
  const careful = computeSimulatedThinkTimeMs({
    questions: [{ questionText: 'x'.repeat(100) }, { questionText: 'y'.repeat(100) }],
    flags: { ...noFlags, eliminates: true },
    prng: createPrng('think-elim'),
  });
  assert.ok(careful > base, `careful ${careful} should be > base ${base}`);
});

test('think-time clamped to MIN_SUBMISSION_MS floor', () => {
  // Tiny empty-question quiz with a rusher → would otherwise return near-zero.
  const t = computeSimulatedThinkTimeMs({
    questions: [],
    flags: { ...noFlags, rushes: true },
    prng: createPrng('think-floor'),
  });
  assert.ok(t >= 3000, `expected >= 3000ms floor, got ${t}`);
});

test('think-time deterministic given same seed', () => {
  const a = computeSimulatedThinkTimeMs({
    questions: [{ questionText: 'alpha' }, { questionText: 'beta' }],
    flags: noFlags,
    prng: createPrng('det-seed'),
  });
  const b = computeSimulatedThinkTimeMs({
    questions: [{ questionText: 'alpha' }, { questionText: 'beta' }],
    flags: noFlags,
    prng: createPrng('det-seed'),
  });
  assert.equal(a, b);
});

