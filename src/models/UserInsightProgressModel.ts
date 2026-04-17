import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import {
  INSIGHT_MODES,
  INSIGHT_RATINGS,
  INSIGHT_STATES,
  InsightMode,
  InsightRating,
  InsightState,
  LEITNER_MAX_BOX,
} from '@lib/insightConstants';

// ── Types ──────────────────────────────────────────────────

export interface IInsightReviewEvent {
  ratedAt: Date;
  rating: InsightRating;
  /** Days elapsed since the previous review when this rating was submitted. */
  elapsedDays: number;
  /** Whether the user was in typed-recall mode when they rated. */
  mode: InsightMode;
  /** For typed-recall: the similarity score (0..1) of their typed answer. */
  typedMatch?: number | null;
}

export interface IUserInsightProgress {
  userId: Types.ObjectId;
  insightId: Types.ObjectId;

  // ── Leitner v0 state ─────────────────────────────
  /** Current Leitner box (0..LEITNER_MAX_BOX). */
  box: number;
  /** Number of successful reviews in a row. */
  reps: number;
  /** Total times the user failed (rated 1/Again). */
  lapses: number;
  /** Coarse FSM state for UI + future FSRS migration. */
  state: InsightState;
  /** Interaction mode for this insight for the current user. */
  mode: InsightMode;

  // ── Scheduling ────────────────────────────────────
  lastReview: Date | null;
  nextDue: Date;

  /**
   * Set ONCE the first time this insight reaches box = LEITNER_MAX_BOX.
   * Never un-set — re-mastery after regression is not celebrated again.
   * Drives `insight_mastery` XP and the `insight_mastered_first` achievement.
   */
  masteredAt: Date | null;

  // ── Audit ────────────────────────────────────────
  history: IInsightReviewEvent[];

  createdAt: Date;
  updatedAt: Date;
}

export type UserInsightProgressDocument = HydratedDocument<IUserInsightProgress>;

// ── Sub-schemas ────────────────────────────────────────────

const reviewEventSchema = new Schema<IInsightReviewEvent>(
  {
    ratedAt: { type: Date, required: true },
    rating: { type: Number, enum: [...INSIGHT_RATINGS], required: true },
    elapsedDays: { type: Number, required: true },
    mode: { type: String, enum: [...INSIGHT_MODES], required: true },
    typedMatch: { type: Number, default: null },
  },
  { _id: false },
);

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<IUserInsightProgress>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    insightId: {
      type: Schema.Types.ObjectId,
      ref: 'Insight',
      required: true,
    },
    box: { type: Number, default: 0, min: 0, max: LEITNER_MAX_BOX },
    reps: { type: Number, default: 0 },
    lapses: { type: Number, default: 0 },
    state: { type: String, enum: [...INSIGHT_STATES], default: 'new' },
    mode: { type: String, enum: [...INSIGHT_MODES], default: 'tap-reveal' },
    lastReview: { type: Date, default: null },
    nextDue: { type: Date, required: true },
    masteredAt: { type: Date, default: null },
    history: { type: [reviewEventSchema], default: [] },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

// A user reviews the same insight at most once at a time; one progress row per pair.
schema.index({ userId: 1, insightId: 1 }, { unique: true });
// Hot query: the daily queue sorts by nextDue for this user.
schema.index({ userId: 1, nextDue: 1 });

// ── Model ──────────────────────────────────────────────────

const UserInsightProgressModel = mongoose.model<IUserInsightProgress>(
  'UserInsightProgress',
  schema,
  'UserInsightProgress',
);

export default UserInsightProgressModel;
