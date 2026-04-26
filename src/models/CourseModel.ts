import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { COURSE_DOMAINS, COURSE_STATUSES, CourseDomain, CourseStatus } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

export interface ICourse {
  userId: Types.ObjectId;
  name: string;
  slug: string | null;
  status: CourseStatus;
  goal: string;
  domain: CourseDomain | null;
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
  // Set whenever a `generate_lesson` job is submitted and cleared when the
  // job ends. Lets the client know — synchronously, the moment `getCourse`
  // returns — exactly which lesson (if any) is being generated, so a
  // reloaded tab can render the generating UI without waiting for a live
  // socket event or for partial content to land in Mongo.
  activeLesson: { moduleIndex: number; lessonIndex: number } | null;
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
    // Bounds protect against DoS via oversized writes. The limits below were
    // picked generously relative to product expectations (course names stay
    // under ~100 chars, goals tend to be 1-3 sentences) while still
    // preventing gigabyte-sized documents from a misbehaving client or LLM.
    // Mongoose only enforces maxlength on new writes — existing docs over
    // the limit are unaffected until they're next saved.
    name: { type: String, default: '', maxlength: 200 },
    slug: { type: String, default: null, maxlength: 200 },
    status: {
      type: String,
      enum: [...COURSE_STATUSES],
      default: 'creating',
    },
    goal: { type: String, required: true, maxlength: 5000 },
    domain: {
      type: String,
      enum: [...COURSE_DOMAINS],
      default: null,
    },
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
      // Each entry is one chat-driven structure-refinement message. 5k per
      // entry is generous for prose feedback; we do not cap the array length
      // here because the feedback loop clears history on major events
      // (see jobRunner.ts `generate_structure` / `refine_structure`), so
      // unbounded growth in practice is bounded by session churn.
      type: [{ type: String, maxlength: 5000 }],
      default: [],
    },
    pendingFeedback: {
      type: String,
      default: null,
      maxlength: 5000,
    },
    currentStep: { type: Number, default: 1 },
    activeJobId: {
      type: Schema.Types.ObjectId,
      ref: 'Job',
      default: null,
    },
    activeLesson: {
      type: new Schema(
        {
          moduleIndex: { type: Number, required: true },
          lessonIndex: { type: Number, required: true },
        },
        { _id: false },
      ),
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
// Partial filter (not `sparse`) because new courses persist `slug: null` until
// the course-design agent fills it in (see `generateUniqueSlug`). A sparse
// index would still index those null values and collide on the second insert
// for a given user; `$type: 'string'` only enforces uniqueness once a real
// slug exists.
schema.index(
  { userId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: 'string' } } },
);

// ── Model ──────────────────────────────────────────────────

const CourseModel = mongoose.model<ICourse>('Course', schema, 'Course');

export default CourseModel;
