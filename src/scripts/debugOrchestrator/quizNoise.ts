/**
 * Pure noise-injection logic for the persona quiz simulator.
 *
 * The LLM call in `answerQuizAsPersona` returns a baseline answer + a
 * self-reported confidence score. This module takes that baseline and
 * applies persona-style-driven randomized distortions to bring the
 * simulator's behavior closer to real-learner distributions — a `rushes`
 * persona should occasionally fall for position bias on long stems, a
 * `guessesWhenUnsure` persona should randomly swap to a distractor when
 * confidence is low, and so on.
 *
 * Split out of courseFlow.ts because the logic is pure — given (pick,
 * confidence, flags, prng) it's deterministic — so tests don't need the
 * OpenAI client or the orchestrator shell. Keeping it LLM-free also means
 * the behavior is auditable at the injection level without running quizzes.
 *
 * Contract: callers provide a seeded PRNG derived from (runId + personaSlug
 * + questionId). Two identical runs yield identical injection traces.
 */

import type { Prng } from './prng';
import type { QuizStyleFlags, QuizNoiseTrace } from './types';

/** Position-bias target: index 0 is slightly over-picked when rushing. */
const POSITION_BIAS_INDEX = 0;

/** Confidence threshold below which `guessesWhenUnsure` kicks in. */
const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Confidence threshold above which `secondGuesses` may flip a correct pick. */
const HIGH_CONFIDENCE_THRESHOLD = 0.7;

/** Stem-length threshold (chars) above which `rushes` triggers position bias. */
const LONG_STEM_THRESHOLD = 200;

/** Injection probabilities — tuned conservatively; iterate based on reruns. */
const P_GUESS_SWAP = 0.3;
const P_RUSH_POSITION_BIAS = 0.15;
const P_SECOND_GUESS_FLIP = 0.1;

export interface ApplyQuizNoiseInput {
  questionId: string;
  questionText: string;
  optionCount: number;
  llmPick: number;
  confidence: number;
  flags: QuizStyleFlags;
  prng: Prng;
}

/**
 * Apply a single persona's noise-injection rules to one LLM answer. Returns
 * the final pick (0..optionCount-1), a trace for the report, and the list
 * of injection names that fired. The function is total — it will never
 * return an out-of-range index or mutate its inputs.
 *
 * Precedence (documented in QuizStyleFlags comment):
 *   rushes > guessesWhenUnsure > secondGuesses > eliminates
 * Only the highest-priority flag whose gate fires applies. This prevents
 * double-injection on a single question, which would make the noise rate
 * non-monotone in the number of active flags.
 */
export const applyQuizNoise = (input: ApplyQuizNoiseInput): {
  finalOption: number;
  trace: QuizNoiseTrace;
} => {
  const { questionId, questionText, optionCount, llmPick, confidence, flags, prng } = input;

  // Guard against malformed upstream output — always land inside [0, optionCount).
  const safePick = Number.isInteger(llmPick) && llmPick >= 0 && llmPick < optionCount
    ? llmPick
    : 0;
  const safeConfidence = Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? confidence
    : 0.5;

  const injections: string[] = [];
  let finalOption = safePick;

  // Priority 1: rushes + long stem → position bias (only if not already biased).
  if (flags.rushes && questionText.length > LONG_STEM_THRESHOLD) {
    if (prng.nextBool(P_RUSH_POSITION_BIAS) && safePick !== POSITION_BIAS_INDEX) {
      finalOption = POSITION_BIAS_INDEX;
      injections.push('rushes:position-bias');
    }
  }

  // Priority 2: low confidence + guessesWhenUnsure → random distractor swap.
  // Only fires if no previous injection landed.
  if (injections.length === 0 && flags.guessesWhenUnsure && safeConfidence < LOW_CONFIDENCE_THRESHOLD) {
    if (prng.nextBool(P_GUESS_SWAP)) {
      // Pick a different option uniformly. Use nextInt on optionCount-1 then
      // skip the original to preserve uniformity over the remaining indices.
      const swapTo = pickDifferentIndex({ current: safePick, optionCount, prng });
      finalOption = swapTo;
      injections.push('guessesWhenUnsure:swap-low-confidence');
    }
  }

  // Priority 3: high confidence + secondGuesses → flip to wrong-looking option.
  // Models the "overthinks and changes a correct answer" pattern. Without a
  // ground-truth correctness check available here (this is pre-submit), we
  // just pick any different option; if the LLM was right, this goes wrong;
  // if the LLM was wrong, this might go right. Net effect: higher variance,
  // which is the point.
  if (injections.length === 0 && flags.secondGuesses && safeConfidence >= HIGH_CONFIDENCE_THRESHOLD) {
    if (prng.nextBool(P_SECOND_GUESS_FLIP)) {
      const swapTo = pickDifferentIndex({ current: safePick, optionCount, prng });
      finalOption = swapTo;
      injections.push('secondGuesses:flip-high-confidence');
    }
  }

  // Priority 4: eliminates is a baseline — no injection. The flag is kept so
  // the report can show it was active, and so future logic (e.g. reduced
  // position bias for eliminators) can branch on it without a schema change.

  return {
    finalOption,
    trace: {
      questionId,
      originalOption: safePick,
      finalOption,
      confidence: safeConfidence,
      injections,
    },
  };
};

const pickDifferentIndex = ({
  current,
  optionCount,
  prng,
}: {
  current: number;
  optionCount: number;
  prng: Prng;
}): number => {
  if (optionCount <= 1) return current;
  const offset = 1 + prng.nextInt(optionCount - 1); // 1..optionCount-1
  return (current + offset) % optionCount;
};

// ── Simulated think-time ──────────────────────────────────

/** Minimum simulated submission time for a whole quiz, in ms. */
const MIN_SUBMISSION_MS = 3000;

/** Base think-time per question, in ms. */
const BASE_QUESTION_MS = 5000;

/** ms added per character of stem text (captures reading time). */
const MS_PER_STEM_CHAR = 10;

export interface ThinkTimeInput {
  questions: { questionText: string }[];
  flags: QuizStyleFlags;
  prng: Prng;
}

/**
 * Compute a realistic simulated quiz submission time based on persona style
 * and stem lengths. This replaces the prior wall-clock `Date.now()` which
 * reflected LLM latency (3-5s), not learner behavior. The result is what
 * the markdown report surfaces as `Submission time`.
 *
 * Model:
 *   total = sum over questions of (base + read_rate * stem_length)
 *   then multipliers: rushes × 0.3, eliminates × 1.5, secondGuesses × 1.3
 *   then jitter ±20% (seeded PRNG — deterministic given the same seed)
 *   then clamped to >= MIN_SUBMISSION_MS
 *
 * The multiplier ordering is multiplicative: a persona with both `rushes`
 * and `eliminates` ends up with 0.3 × 1.5 = 0.45× baseline. That's an
 * intentional design — the conflicting signals produce moderate times, not
 * extremes. The generator is instructed to produce mutually-exclusive
 * dominant traits, so this combination is rare in practice.
 */
export const computeSimulatedThinkTimeMs = (input: ThinkTimeInput): number => {
  const { questions, flags, prng } = input;
  let baseMs = 0;
  for (const q of questions) {
    baseMs += BASE_QUESTION_MS + MS_PER_STEM_CHAR * q.questionText.length;
  }

  let multiplier = 1;
  if (flags.rushes) multiplier *= 0.3;
  if (flags.eliminates) multiplier *= 1.5;
  if (flags.secondGuesses) multiplier *= 1.3;

  const jitter = 0.8 + prng.nextFloat() * 0.4; // [0.8, 1.2)
  const totalMs = baseMs * multiplier * jitter;
  return Math.max(MIN_SUBMISSION_MS, Math.round(totalMs));
};
