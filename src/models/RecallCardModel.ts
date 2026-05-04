import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { RECALL_CARD_KINDS, RecallCardKind } from '@lib/recallConstants';

// ── Types ──────────────────────────────────────────────────

export interface IRecallCard {
  courseId: Types.ObjectId;
  lessonId: Types.ObjectId;
  moduleIndex: number;
  lessonIndex: number;
  sourceBlockId: string;
  kind: RecallCardKind;
  /** For qa: question text. For cloze: sentence with a single {{blank}} marker. */
  prompt: string;
  /** For qa: answer. For cloze: the word/phrase that fills {{blank}}. */
  answer: string;
  conceptTags: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type RecallCardDocument = HydratedDocument<IRecallCard>;

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<IRecallCard>(
  {
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    lessonId: {
      type: Schema.Types.ObjectId,
      ref: 'LessonContent',
      required: true,
    },
    moduleIndex: { type: Number, required: true },
    lessonIndex: { type: Number, required: true },
    sourceBlockId: { type: String, required: true },
    kind: { type: String, enum: [...RECALL_CARD_KINDS], required: true },
    prompt: { type: String, required: true },
    answer: { type: String, required: true },
    conceptTags: { type: [String], default: [] },
    version: { type: Number, default: 1 },
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

// Hot paths: fetch recall cards for a lesson (regen/cleanup), or for a course (feed).
schema.index({ lessonId: 1 });
schema.index({ courseId: 1 });
schema.index({ conceptTags: 1 });

// ── Model ──────────────────────────────────────────────────

const RecallCardModel = mongoose.model<IRecallCard>('RecallCard', schema, 'RecallCard');

export default RecallCardModel;
