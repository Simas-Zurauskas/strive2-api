import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import {
  RECALL_MODES,
  RECALL_RATINGS,
  RECALL_STATES,
  RecallMode,
  RecallRating,
  RecallState,
  LEITNER_MAX_BOX,
} from '@lib/recallConstants';

// ── Types ──────────────────────────────────────────────────

export interface IRecallReviewEvent {
  ratedAt: Date;
  rating: RecallRating;
  /** Days elapsed since the previous review when this rating was submitted. */
  elapsedDays: number;
  /** Whether the user was in typed-recall mode when they rated. */
  mode: RecallMode;
  /** For typed-recall: the similarity score (0..1) of their typed answer. */
  typedMatch?: number | null;
}

export interface IUserRecallProgress {
  userId: Types.ObjectId;
  recallCardId: Types.ObjectId;

  // ── Leitner v0 state ─────────────────────────────
  /** Current Leitner box (0..LEITNER_MAX_BOX). */
  box: number;
  /** Number of successful reviews in a row. */
  reps: number;
  /** Total times the user failed (rated 1/Again). */
  lapses: number;
  /** Coarse FSM state for UI + future FSRS migration. */
  state: RecallState;
  /** Interaction mode for this recall card for the current user. */
  mode: RecallMode;

  // ── Scheduling ────────────────────────────────────
  lastReview: Date | null;
  nextDue: Date;

  /**
   * Set ONCE the first time this recall card reaches box = LEITNER_MAX_BOX.
   * Never un-set — re-mastery after regression is not celebrated again.
   * Drives `recall_mastery` XP and the `recall_mastered_first` achievement.
   */
  masteredAt: Date | null;

  // ── Audit ────────────────────────────────────────
  history: IRecallReviewEvent[];

  createdAt: Date;
  updatedAt: Date;
}

export type UserRecallProgressDocument = HydratedDocument<IUserRecallProgress>;

// ── Sub-schemas ────────────────────────────────────────────

const reviewEventSchema = new Schema<IRecallReviewEvent>(
  {
    ratedAt: { type: Date, required: true },
    rating: { type: Number, enum: [...RECALL_RATINGS], required: true },
    elapsedDays: { type: Number, required: true },
    mode: { type: String, enum: [...RECALL_MODES], required: true },
    typedMatch: { type: Number, default: null },
  },
  { _id: false },
);

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<IUserRecallProgress>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    recallCardId: {
      type: Schema.Types.ObjectId,
      ref: 'RecallCard',
      required: true,
    },
    box: { type: Number, default: 0, min: 0, max: LEITNER_MAX_BOX },
    reps: { type: Number, default: 0 },
    lapses: { type: Number, default: 0 },
    state: { type: String, enum: [...RECALL_STATES], default: 'new' },
    mode: { type: String, enum: [...RECALL_MODES], default: 'tap-reveal' },
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

// A user reviews the same recall card at most once at a time; one progress row per pair.
schema.index({ userId: 1, recallCardId: 1 }, { unique: true });
// Hot query: the daily queue sorts by nextDue for this user.
schema.index({ userId: 1, nextDue: 1 });

// ── Model ──────────────────────────────────────────────────

const UserRecallProgressModel = mongoose.model<IUserRecallProgress>(
  'UserRecallProgress',
  schema,
  'UserRecallProgress',
);

export default UserRecallProgressModel;
