import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { LESSON_PROGRESS_STATUSES, LessonProgressStatus } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

export interface IQuizResponse {
  blockId: string;
  selectedOption: number;
  correct: boolean;
  answeredAt: Date;
}

export interface IExerciseAttempt {
  blockId: string;
  code: string;
  passed: boolean;
  attemptedAt: Date;
}

export interface IUserLessonProgress {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  moduleIndex: number;
  lessonIndex: number;
  status: LessonProgressStatus;
  completedAt: Date | null;
  lastAccessedAt: Date;
  timeSpentSeconds: number;
  quizResponses: IQuizResponse[];
  exerciseAttempts: IExerciseAttempt[];
  notes: string | null;
  bookmarked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type UserLessonProgressDocument = HydratedDocument<IUserLessonProgress>;

// ── Sub-schemas ────────────────────────────────────────────

const quizResponseSchema = new Schema<IQuizResponse>(
  {
    blockId: { type: String, required: true },
    selectedOption: { type: Number, required: true },
    correct: { type: Boolean, required: true },
    answeredAt: { type: Date, required: true },
  },
  { _id: false },
);

const exerciseAttemptSchema = new Schema<IExerciseAttempt>(
  {
    blockId: { type: String, required: true },
    code: { type: String, required: true },
    passed: { type: Boolean, required: true },
    attemptedAt: { type: Date, required: true },
  },
  { _id: false },
);

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<IUserLessonProgress>(
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
    lessonIndex: { type: Number, required: true },
    status: {
      type: String,
      enum: [...LESSON_PROGRESS_STATUSES],
      default: 'not_started',
    },
    completedAt: { type: Date, default: null },
    lastAccessedAt: { type: Date, default: Date.now },
    timeSpentSeconds: { type: Number, default: 0 },
    quizResponses: { type: [quizResponseSchema], default: [] },
    exerciseAttempts: { type: [exerciseAttemptSchema], default: [] },
    notes: { type: String, default: null, maxlength: 10000 },
    bookmarked: { type: Boolean, default: false },
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

schema.index({ userId: 1, courseId: 1, moduleIndex: 1, lessonIndex: 1 }, { unique: true });
schema.index({ userId: 1, courseId: 1 });
schema.index({ userId: 1, lastAccessedAt: -1 });

// `countDocuments({ userId, status: 'completed' })` is fired on every
// continue-learning / progress-summary request; without a covering index
// it forces a scan over every lesson the user has ever touched. At ~100
// lessons per user the scan is free; at several hundred it becomes the p99
// bottleneck on the dashboard.
schema.index({ userId: 1, status: 1 });

// Bookmarked-lessons feed is small (<100 items per user) but queried
// frequently; the boolean filter benefits from a sparse index more than a
// dense one because most rows have `bookmarked: false`.
schema.index({ userId: 1, bookmarked: 1 }, { sparse: true });

// ── Model ──────────────────────────────────────────────────

const UserLessonProgressModel = mongoose.model<IUserLessonProgress>(
  'UserLessonProgress',
  schema,
  'UserLessonProgress',
);

export default UserLessonProgressModel;
