// ── Insight kinds ──────────────────────────────────────────

export const INSIGHT_KINDS = ['qa', 'cloze'] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

// ── Rating (Anki-style 4-button) ──────────────────────────

export const INSIGHT_RATINGS = [1, 2, 3, 4] as const;
export type InsightRating = (typeof INSIGHT_RATINGS)[number];

export const INSIGHT_RATING_LABELS: Record<InsightRating, string> = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};

// ── Scheduler state ────────────────────────────────────────

export const INSIGHT_STATES = ['new', 'learning', 'review', 'relearning'] as const;
export type InsightState = (typeof INSIGHT_STATES)[number];

export const INSIGHT_MODES = ['tap-reveal', 'typed-recall'] as const;
export type InsightMode = (typeof INSIGHT_MODES)[number];

// ── Leitner v0 schedule ───────────────────────────────────
// Phase 0 scheduler. Each rating maps the card to a box (0..4) with a fixed
// interval. Rating → box delta:
//   1 (Again): reset to box 0, reschedule 1d, increment lapses
//   2 (Hard):  box stays (min box 0), reschedule at current box interval
//   3 (Good):  box + 1 (capped at MAX_BOX)
//   4 (Easy):  box + 2 (capped at MAX_BOX)

export const LEITNER_MAX_BOX = 4;

export const LEITNER_BOX_INTERVAL_DAYS: Record<number, number> = {
  0: 1,   // new or just failed
  1: 3,
  2: 7,
  3: 14,
  4: 30,
};

export const INSIGHT_SKIP_DAYS = 1;

// ── Queue limits ───────────────────────────────────────────

export const INSIGHT_QUEUE_DUE_LIMIT = 25;       // hard cap on due items served per request
export const INSIGHT_QUEUE_FRESH_LIMIT_DEFAULT = 5;  // fresh items mixed in when queue small
export const INSIGHT_QUEUE_FRESH_THRESHOLD = 20; // if due >= this, no fresh items

// ── Generation budget per lesson ──────────────────────────

export const INSIGHT_MIN_PER_LESSON = 3;
export const INSIGHT_MAX_PER_LESSON = 5;

// ── Concept-tag vocabulary ────────────────────────────────
// Tags are normalized lowercase slugs (kebab-case), emitted by the
// generator. Kept free-form (not enum-constrained) so the LLM can produce
// topic-specific tags; we just normalize formatting.

export const normalizeConceptTag = (raw: string): string =>
  raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
