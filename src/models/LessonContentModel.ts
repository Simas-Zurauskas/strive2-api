import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';

// ── Types ──────────────────────────────────────────────────

export const BLOCK_TYPES = [
  'intro', 'section', 'code', 'mermaid', 'callout',
  'quiz', 'exercise', 'summary', 'links', 'image',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export interface ILessonBlock {
  id: string;
  type: BlockType;
  content: string;
  metadata: Record<string, unknown> | null;
  order: number;
}

export interface ILessonContent {
  courseId: Types.ObjectId;
  moduleIndex: number;
  lessonIndex: number;
  blocks: ILessonBlock[];
  heroImageUrl: string | null;
  includeHeroImage: boolean;
  audioUrl: string | null;
  summary: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type LessonContentDocument = HydratedDocument<ILessonContent>;

// ── Schema ─────────────────────────────────────────────────

const blockSchema = new Schema<ILessonBlock>(
  {
    id: { type: String, required: true },
    type: { type: String, enum: [...BLOCK_TYPES], required: true },
    content: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: null },
    order: { type: Number, required: true },
  },
  { _id: false },
);

const schema = new Schema<ILessonContent>(
  {
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    moduleIndex: { type: Number, required: true },
    lessonIndex: { type: Number, required: true },
    blocks: { type: [blockSchema], default: [] },
    heroImageUrl: { type: String, default: null },
    includeHeroImage: { type: Boolean, default: true },
    audioUrl: { type: String, default: null },
    summary: { type: String, default: null },
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

schema.index({ courseId: 1, moduleIndex: 1, lessonIndex: 1 }, { unique: true });

// ── Model ──────────────────────────────────────────────────

const LessonContentModel = mongoose.model<ILessonContent>('LessonContent', schema, 'LessonContent');

export default LessonContentModel;
