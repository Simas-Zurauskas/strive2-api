import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { INSIGHT_KINDS, InsightKind } from '@lib/insightConstants';

// ── Types ──────────────────────────────────────────────────

export interface IInsight {
  courseId: Types.ObjectId;
  lessonId: Types.ObjectId;
  moduleIndex: number;
  lessonIndex: number;
  sourceBlockId: string;
  kind: InsightKind;
  /** For qa: question text. For cloze: sentence with a single {{blank}} marker. */
  prompt: string;
  /** For qa: answer. For cloze: the word/phrase that fills {{blank}}. */
  answer: string;
  conceptTags: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type InsightDocument = HydratedDocument<IInsight>;

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<IInsight>(
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
    kind: { type: String, enum: [...INSIGHT_KINDS], required: true },
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

// Hot paths: fetch insights for a lesson (regen/cleanup), or for a course (feed).
schema.index({ lessonId: 1 });
schema.index({ courseId: 1 });
schema.index({ conceptTags: 1 });

// ── Model ──────────────────────────────────────────────────

const InsightModel = mongoose.model<IInsight>('Insight', schema, 'Insight');

export default InsightModel;
