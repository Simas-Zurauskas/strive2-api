import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { CHAT_ROLES } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

/**
 * A successful `emit_handoff` tool result persisted alongside the
 * assistant message that produced it. Stored verbatim from the tool's
 * validated payload so the client can re-render the same button on
 * page reload without re-running the agent. Failures (`ok: false`)
 * are deliberately not persisted — they were transient signals to the
 * agent during the live turn, not durable artifacts of the response.
 */
export interface ICourseMentorChatHandoff {
  target: 'quiz' | 'recall' | 'lesson';
  moduleIndex?: number;
  lessonIndex?: number;
  label: string;
}

export interface ICourseMentorChatMessage {
  role: (typeof CHAT_ROLES)[number];
  content: string;
  /**
   * Persisted handoff buttons rendered under this message. Optional;
   * almost all messages won't have any. Stored on the assistant turn
   * that issued the emit_handoff call.
   */
  handoffs?: ICourseMentorChatHandoff[];
  createdAt: Date;
}

/**
 * Rolling summary of older history. Present once the chat first
 * crosses the compression threshold. See `messageCompression.ts`.
 */
export interface ICourseMentorChatSummary {
  text: string;
  upToMessageCount: number;
  updatedAt: Date;
}

/**
 * Course-scoped mentor chat session. Distinct from `LessonMentorChat`
 * (one per `userId+courseId+moduleIndex+lessonIndex`) — this one is one
 * per `userId+courseId`. The two chats run in parallel: a learner who
 * navigates between course-overview and a lesson sees them as two
 * independent conversations, each with its own history.
 *
 * No attachments in v1. The course mentor's role is navigation /
 * orientation / cross-module synthesis — discussing a pasted PDF is a
 * lesson-mentor job and rare at this scope. Revisit if usage shows
 * demand.
 */
export interface ICourseMentorChat {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  messages: ICourseMentorChatMessage[];
  summary?: ICourseMentorChatSummary;
  createdAt: Date;
  updatedAt: Date;
}

export type CourseMentorChatDocument = HydratedDocument<ICourseMentorChat>;

// ── Schema ─────────────────────────────────────────────────

const handoffSchema = new Schema<ICourseMentorChatHandoff>(
  {
    target: {
      type: String,
      enum: ['quiz', 'recall', 'lesson'],
      required: true,
    },
    moduleIndex: { type: Number },
    lessonIndex: { type: Number },
    label: { type: String, required: true, maxlength: 100 },
  },
  { _id: false },
);

const summarySchema = new Schema<ICourseMentorChatSummary>(
  {
    text: { type: String, required: true, maxlength: 4_000 },
    upToMessageCount: { type: Number, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const messageSchema = new Schema<ICourseMentorChatMessage>(
  {
    role: {
      type: String,
      enum: [...CHAT_ROLES],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    handoffs: {
      type: [handoffSchema],
      default: undefined,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true },
);

const schema = new Schema<ICourseMentorChat>(
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
    messages: {
      type: [messageSchema],
      default: [],
    },
    summary: {
      type: summarySchema,
      default: undefined,
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

schema.index({ userId: 1, courseId: 1 }, { unique: true });

// ── Model ──────────────────────────────────────────────────

const CourseMentorChatModel = mongoose.model<ICourseMentorChat>(
  'CourseMentorChat',
  schema,
  'CourseMentorChat',
);

export default CourseMentorChatModel;
