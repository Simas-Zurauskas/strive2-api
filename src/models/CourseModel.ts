import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { COURSE_STATUSES, CourseStatus } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

export interface ICourse {
  userId: Types.ObjectId;
  name: string;
  status: CourseStatus;
  goal: string;
  clarifyData: {
    questions: { id: string; question: string; type: string; options: string[] | null }[];
  } | null;
  answers: Record<string, unknown> | null;
  depth: string | null;
  structure: {
    reasoning: {
      learnerProfile: string;
      topicAnalysis: string;
      scopeDecisions: string;
      progressionStrategy: string;
    };
    modules: {
      name: string;
      description: string;
      lessons: { name: string; description: string }[];
    }[];
  } | null;
  depthPreviews: {
    overview: { summary: string; bullets: string[] };
    comprehensive: { summary: string; bullets: string[] };
    deep_dive: { summary: string; bullets: string[] };
    recommended: string;
    recommendationReason: string;
  } | null;
  feedbackHistory: string[];
  pendingFeedback: string | null;
  currentStep: number;
  activeJobId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CourseDocument = HydratedDocument<ICourse>;

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<ICourse>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: { type: String, default: '' },
    status: {
      type: String,
      enum: [...COURSE_STATUSES],
      default: 'creating',
    },
    goal: { type: String, required: true },
    clarifyData: {
      type: Schema.Types.Mixed,
      default: null,
    },
    answers: {
      type: Schema.Types.Mixed,
      default: null,
    },
    depth: {
      type: String,
      default: null,
    },
    depthPreviews: {
      type: Schema.Types.Mixed,
      default: null,
    },
    structure: {
      type: Schema.Types.Mixed,
      default: null,
    },
    feedbackHistory: {
      type: [String],
      default: [],
    },
    pendingFeedback: {
      type: String,
      default: null,
    },
    currentStep: { type: Number, default: 1 },
    activeJobId: {
      type: Schema.Types.ObjectId,
      ref: 'Job',
      default: null,
    },
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

schema.index({ userId: 1, updatedAt: -1 });

// ── Model ──────────────────────────────────────────────────

const CourseModel = mongoose.model<ICourse>('Course', schema, 'Course');

export default CourseModel;
