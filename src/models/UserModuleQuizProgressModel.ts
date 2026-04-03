import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { QUIZ_MASTERY_TIERS, QuizMasteryTier } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

export interface IQuizAttemptResponse {
  questionId: string;
  selectedOption: number;
  correct: boolean;
  answeredAt: Date;
}

export interface IQuizAttempt {
  attemptNumber: number;
  responses: IQuizAttemptResponse[];
  score: number;
  masteryTier: QuizMasteryTier;
  completedAt: Date;
  quizVersion: number;
}

export interface IUserModuleQuizProgress {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  moduleIndex: number;
  attempts: IQuizAttempt[];
  bestScore: number;
  bestTier: QuizMasteryTier | null;
  // Spaced review scheduling
  reviewIntervalDays: number;
  consecutiveSuccesses: number;
  nextReviewAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserModuleQuizProgressDocument = HydratedDocument<IUserModuleQuizProgress>;

// ── Sub-schemas ────────────────────────────────────────────

const attemptResponseSchema = new Schema<IQuizAttemptResponse>(
  {
    questionId: { type: String, required: true },
    selectedOption: { type: Number, required: true },
    correct: { type: Boolean, required: true },
    answeredAt: { type: Date, required: true },
  },
  { _id: false },
);

const attemptSchema = new Schema<IQuizAttempt>(
  {
    attemptNumber: { type: Number, required: true },
    responses: { type: [attemptResponseSchema], default: [] },
    score: { type: Number, required: true },
    masteryTier: { type: String, enum: [...QUIZ_MASTERY_TIERS], required: true },
    completedAt: { type: Date, required: true },
    quizVersion: { type: Number, required: true },
  },
  { _id: false },
);

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<IUserModuleQuizProgress>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    moduleIndex: { type: Number, required: true },
    attempts: { type: [attemptSchema], default: [] },
    bestScore: { type: Number, default: 0 },
    bestTier: { type: String, enum: [...QUIZ_MASTERY_TIERS], default: null },
    reviewIntervalDays: { type: Number, default: 0 },
    consecutiveSuccesses: { type: Number, default: 0 },
    nextReviewAt: { type: Date, default: null },
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

schema.index({ userId: 1, courseId: 1, moduleIndex: 1 }, { unique: true });
schema.index({ userId: 1, courseId: 1 });
schema.index({ userId: 1, nextReviewAt: 1 });

// ── Model ──────────────────────────────────────────────────

const UserModuleQuizProgressModel = mongoose.model<IUserModuleQuizProgress>(
  'UserModuleQuizProgress',
  schema,
  'UserModuleQuizProgress',
);

export default UserModuleQuizProgressModel;
