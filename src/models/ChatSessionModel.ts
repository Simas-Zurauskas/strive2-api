import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { CHAT_ROLES } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

export interface IChatMessage {
  role: (typeof CHAT_ROLES)[number];
  content: string;
  createdAt: Date;
}

export interface IChatSession {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  messages: IChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export type ChatSessionDocument = HydratedDocument<IChatSession>;

// ── Schema ─────────────────────────────────────────────────

const messageSchema = new Schema<IChatMessage>(
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
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true },
);

const schema = new Schema<IChatSession>(
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

const ChatSessionModel = mongoose.model<IChatSession>('ChatSession', schema, 'ChatSession');

export default ChatSessionModel;
