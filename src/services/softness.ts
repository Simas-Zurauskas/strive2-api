import { CourseDepth } from '@lib/constants';

/**
 * "Softness" signal detection.
 *
 * Across multiple debug-orchestrator assessments we observed a recurring
 * failure where the depth recommender (and the structure generator)
 * produced pathologically large courses for learners whose clarify answers
 * signalled light effort — phrases like "just want to learn", "lighter
 * load", "minimal effort". Examples:
 *   - 32 lessons of Comprehensive personal finance for "Just want to learn more"
 *   - 21 lessons of Overview photography after the user *down-overrode* depth
 *     citing "I prefer a lighter load"
 *   - 87 lessons of Deep Dive Python for an over-ambitious self-described
 *     newbie (different failure mode; see depth-override modal — Part 3).
 *
 * This module is the first half of the fix: detect the signal and let the
 * LLM steer toward a smaller course. No DB persistence — the helper is
 * called at the start of `generateDepthPreviews` and `generateCourseStructure`
 * so both stages see the same hint.
 *
 * Heuristic only: case-insensitive substring match against an allowlist of
 * light-effort phrases. False positives (e.g. negation like "I don't just
 * want to learn") are rare in practice and accepted in MVP. False negatives
 * (non-English softness, idioms not on the list) leave behavior unchanged.
 */

const SOFTNESS_PHRASES: readonly string[] = [
  // ── Original set (Phase 1 softness work) ──
  'just want to learn',
  'just curious',
  'just exploring',
  'lighter load',
  'lighter version',
  'minimal effort',
  'minimum effort',
  'low effort',
  'no time',
  'limited time',
  'short on time',
  'casual',
  'for fun',
  'for kicks',
  'overwhelmed',
  'overwhelm me',
  'quick overview',
  'high level',
  'high-level',
  'broad strokes',
  'skim',
  'basics only',
  'just the basics',
  'just basics',
  'get a sense',
  'dabble',
  'dipping my toe',
  'toes in',
  'no pressure',
  'easygoing',
  'easy-going',

  // ── Commitment uncertainty (2026-04-20 assessment) ──
  // FP-check: all phrases require self-referential framing that's rare in
  // topic-describing answers. "Not sure yet" is conversational and doesn't
  // appear in a technical topic description.
  'not sure yet',
  'might try',
  'thinking about',
  'still deciding',
  'just exploring options',

  // ── Effort constraints ──
  // FP-check: "part-time" and "on the side" are time-commitment signals
  // that don't appear in MC-option text. "I'm busy" is anchored to the
  // self-report; "busy industry" or "busy professional" use "busy" as
  // adjective, which is not captured by the anchored phrase.
  "can't commit",
  "can't finish",
  'start strong but',
  "i'm busy",
  'too busy',
  'part-time',
  'on the side',

  // ── Priority softening ──
  // FP-check: "moderately important" is distinctive — teaching prose uses
  // "highly important", "critically important", or "essential"; "moderately"
  // is specifically a priority-dampener. "Nice to have" is a product-mgmt
  // convention and doesn't appear in topic descriptions.
  'moderately important',
  'not a priority',
  'not that important',
  'nice to have',

  // ── Explicit overwhelm / decision-fatigue ──
  // FP-check: "too much" alone is common ("too much detail" in a positive
  // context), so we anchor to "too much for me" / "too much to".
  'too much for me',
  'too much to',
  'easily overwhelmed',
];

export interface SoftnessHint {
  /** True when at least one softness phrase matched any answer. */
  isSoft: boolean;
  /**
   * Human-readable cues, e.g. ["free-text matched 'just want to learn'"].
   * Safe to interpolate into LLM prompts; cues are drawn from the allowlist
   * (not from raw user input), so there is no injection vector here.
   */
  cues: string[];
}

interface DetectInput {
  answers: { questionId: string; answer: string }[];
}

/**
 * Pure function — scans all answer strings for any matched softness phrase.
 * Returns an array of canonical phrases (deduped) we hit, plus the boolean.
 */
export const detectSoftnessHint = ({ answers }: DetectInput): SoftnessHint => {
  if (!answers || answers.length === 0) return { isSoft: false, cues: [] };

  const matched = new Set<string>();
  for (const { answer } of answers) {
    if (typeof answer !== 'string' || !answer) continue;
    const lower = answer.toLowerCase();
    for (const phrase of SOFTNESS_PHRASES) {
      if (lower.includes(phrase)) matched.add(phrase);
    }
  }

  if (matched.size === 0) return { isSoft: false, cues: [] };
  const cues = Array.from(matched).map((p) => `learner answer contained "${p}"`);
  return { isSoft: true, cues };
};

/**
 * Total-lesson-count hint per (depth, isSoft).
 *
 * These are HINTS the prompt asks the LLM to respect, not hard limits
 * enforced by code. Prior runs without bounds produced 21 / 32 / 54 / 87
 * lesson courses; the hints below pull those toward what the depth tier
 * actually means to a learner.
 *
 * Ranges (min, max) leave room for the LLM to size to topic complexity:
 *   overview: a short course
 *   comprehensive: a thorough course with hands-on application
 *   deep_dive: extensive mastery — large but bounded
 *
 * Soft-signal columns are roughly 2/3 of the normal range, applied any
 * time `detectSoftnessHint` matched.
 */
export const LESSON_COUNT_HINTS: Record<CourseDepth, { soft: [number, number]; normal: [number, number] }> = {
  // Soft ceilings tightened ~20% (2026-04-20 assessment revision). The prior
  // soft ceilings still produced 25- and 28-lesson "comprehensive" courses
  // for learners whose Profile flagged low commitment. Empirically even the
  // 12-20 cap was too generous — pulling to 8-16 brings soft-comprehensive
  // closer to what a non-committed learner will actually complete. Normal
  // bands are UNCHANGED — this tightening only affects SOFT=YES learners.
  overview: { soft: [4, 8], normal: [8, 14] },
  comprehensive: { soft: [8, 16], normal: [18, 28] },
  deep_dive: { soft: [20, 32], normal: [36, 56] },
};

interface CapInput {
  depth: CourseDepth;
  isSoft: boolean;
}

export const getLessonCountHint = ({ depth, isSoft }: CapInput): [number, number] => {
  const band = LESSON_COUNT_HINTS[depth];
  return isSoft ? band.soft : band.normal;
};
