/**
 * Seeded PRNG for the debug orchestrator's noise-injection paths.
 *
 * Uses Mulberry32 (a 32-bit state, high-quality-for-its-size generator) fed
 * by an FNV-1a hash of the seed string. Zero dep, ~30 LOC. Sufficient for
 * simulating persona-style randomization — we're not doing cryptography,
 * we're flipping coins to choose whether a "rushes" persona falls for
 * position bias on question 3 of a quiz.
 *
 * Determinism contract: for a given `seedString`, the `nextFloat` /
 * `nextInt` / `nextBool` sequence is identical on every run, every
 * machine. This is the core property we need for reproducible orchestrator
 * runs — two identical runs with identical persona + quiz inputs produce
 * byte-identical noise outcomes.
 *
 * Scope: intentionally NOT a drop-in Math.random replacement. Expose only
 * the three methods the quiz-noise and typed-recall paths need. Adding
 * helpers (e.g. `weightedChoice`) is fine; adding Math.random-compatible
 * aliases (e.g. a bare `random()`) would invite accidental use outside the
 * orchestrator and is out of scope.
 */

export interface Prng {
  /** Uniform float in [0, 1). */
  nextFloat: () => number;
  /** Uniform integer in [0, max). `max` must be a positive integer. */
  nextInt: (max: number) => number;
  /** True with the given probability ∈ [0, 1]. */
  nextBool: (probability: number) => boolean;
}

/**
 * FNV-1a 32-bit string hash. Fast, reasonable-quality distribution, zero
 * collisions for the short composite seeds we use (`runId:personaSlug:...`).
 * Not cryptographically secure — same caveat as the generator itself.
 */
const fnv1a32 = (input: string): number => {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Multiply by FNV prime (16777619) via shift-add trick for non-BigInt safety.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
};

/**
 * Mulberry32 generator. Standard high-quality-for-32-bit-state PRNG. No
 * warmup required — output is well-distributed from the first call.
 */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const createPrng = (seedString: string): Prng => {
  if (typeof seedString !== 'string' || seedString.length === 0) {
    throw new Error('createPrng: seedString must be a non-empty string');
  }
  const next = mulberry32(fnv1a32(seedString));
  return {
    nextFloat: () => next(),
    nextInt: (max: number) => {
      if (!Number.isInteger(max) || max <= 0) {
        throw new Error(`Prng.nextInt: max must be a positive integer, got ${max}`);
      }
      return Math.floor(next() * max);
    },
    nextBool: (probability: number) => {
      if (typeof probability !== 'number' || probability < 0 || probability > 1) {
        throw new Error(`Prng.nextBool: probability must be in [0, 1], got ${probability}`);
      }
      return next() < probability;
    },
  };
};
