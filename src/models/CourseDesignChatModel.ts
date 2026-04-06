import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { CHAT_ROLES } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

export interface ICourseDesignChatMessage {
  role: (typeof CHAT_ROLES)[number];
  content: string;
  createdAt: Date;
}

export interface ICourseDesignChat {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  messages: ICourseDesignChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export type CourseDesignChatDocument = HydratedDocument<ICourseDesignChat>;

// ── Schema ─────────────────────────────────────────────────

const messageSchema = new Schema<ICourseDesignChatMessage>(
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

const schema = new Schema<ICourseDesignChat>(
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

const CourseDesignChatModel = mongoose.model<ICourseDesignChat>('CourseDesignChat', schema, 'CourseDesignChat');

export default CourseDesignChatModel;
