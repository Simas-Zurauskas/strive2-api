import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { CHAT_ROLES } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

/**
 * Lightweight pointer that lets a saved chat message reference the
 * full content stored in the session-level `attachments` array. Past
 * user messages render their chips by joining this id back through
 * the session map. We deliberately don't denormalise filename/size
 * here — a single dedupe/cap source of truth is easier to reason
 * about than two stores that can drift.
 */
export interface ILessonMentorMessageAttachmentRef {
  attachmentId: string;
}

/**
 * A successful `emit_handoff` tool result persisted alongside the
 * assistant message that issued it. See CourseMentorChat for the
 * full rationale; same shape, different scope.
 */
export interface ILessonMentorChatHandoff {
  target: 'quiz' | 'insights' | 'lesson';
  moduleIndex?: number;
  lessonIndex?: number;
  label: string;
}

export interface ILessonMentorChatMessage {
  role: (typeof CHAT_ROLES)[number];
  content: string;
  attachments?: ILessonMentorMessageAttachmentRef[];
  /** Persisted handoff buttons rendered under this message. */
  handoffs?: ILessonMentorChatHandoff[];
  createdAt: Date;
}

/**
 * Session-scoped attachment store. Owned by the chat document so the
 * existing cleanup cascade (clear chat / course delete / user delete
 * via cleanupCourseContent) drops attachments without any new wiring.
 *
 * `text` holds the full extracted content; size is capped upstream
 * (50K tokens per file in attachmentService, 120K cumulative across
 * the session). At those caps a worst-case doc is ~1 MB — well under
 * Mongo's 16 MB cap, no GridFS needed.
 *
 * `sha256` is the dedupe key — re-uploading the same file returns the
 * existing entry rather than appending a duplicate.
 */
export interface ILessonMentorAttachment {
  id: string;
  filename: string;
  kind: 'pdf' | 'text';
  approxTokens: number;
  text: string;
  sha256: string;
  createdAt: Date;
}

/**
 * Rolling summary of older history. Present once the chat first
 * crosses the compression threshold. `upToMessageCount` is the number
 * of leading entries from `messages[]` baked into `text`; the
 * remaining tail is fed verbatim to the LLM. See `messageCompression.ts`.
 */
export interface ILessonMentorChatSummary {
  text: string;
  upToMessageCount: number;
  updatedAt: Date;
}

export interface ILessonMentorChat {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  moduleIndex: number;
  lessonIndex: number;
  messages: ILessonMentorChatMessage[];
  attachments: ILessonMentorAttachment[];
  summary?: ILessonMentorChatSummary;
  createdAt: Date;
  updatedAt: Date;
}

export type LessonMentorChatDocument = HydratedDocument<ILessonMentorChat>;

// ── Schema ─────────────────────────────────────────────────

const messageAttachmentRefSchema = new Schema<ILessonMentorMessageAttachmentRef>(
  {
    attachmentId: { type: String, required: true },
  },
  { _id: false },
);

const handoffSchema = new Schema<ILessonMentorChatHandoff>(
  {
    target: {
      type: String,
      enum: ['quiz', 'insights', 'lesson'],
      required: true,
    },
    moduleIndex: { type: Number },
    lessonIndex: { type: Number },
    label: { type: String, required: true, maxlength: 100 },
  },
  { _id: false },
);

const messageSchema = new Schema<ILessonMentorChatMessage>(
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
    attachments: {
      type: [messageAttachmentRefSchema],
      default: undefined,
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

const summarySchema = new Schema<ILessonMentorChatSummary>(
  {
    text: { type: String, required: true, maxlength: 4_000 },
    upToMessageCount: { type: Number, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const attachmentSchema = new Schema<ILessonMentorAttachment>(
  {
    id: { type: String, required: true },
    filename: { type: String, required: true, maxlength: 256 },
    kind: { type: String, enum: ['pdf', 'text'], required: true },
    approxTokens: { type: Number, required: true },
    // Hard cap at the same size attachmentService allows (~200K chars
    // post-extraction). Mongo enforces this at the schema layer as a
    // belt-and-braces check against a future bug in the cap logic.
    text: { type: String, required: true, maxlength: 250_000 },
    sha256: { type: String, required: true, maxlength: 64 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const schema = new Schema<ILessonMentorChat>(
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
    moduleIndex: {
      type: Number,
      required: true,
    },
    lessonIndex: {
      type: Number,
      required: true,
    },
    messages: {
      type: [messageSchema],
      default: [],
    },
    attachments: {
      type: [attachmentSchema],
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

schema.index({ userId: 1, courseId: 1, moduleIndex: 1, lessonIndex: 1 }, { unique: true });

// ── Model ──────────────────────────────────────────────────

const LessonMentorChatModel = mongoose.model<ILessonMentorChat>(
  'LessonMentorChat',
  schema,
  'LessonMentorChat',
);

export default LessonMentorChatModel;
