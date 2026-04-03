import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';

// ── Types ──────────────────────────────────────────────────

export interface IModuleQuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  sourceLessons: number[];
  isInterleaved: boolean;
  interleavedModuleIndex?: number;
}

export interface IModuleQuizContent {
  courseId: Types.ObjectId;
  moduleIndex: number;
  questions: IModuleQuizQuestion[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ModuleQuizContentDocument = HydratedDocument<IModuleQuizContent>;

// ── Sub-schemas ────────────────────────────────────────────

const questionSchema = new Schema<IModuleQuizQuestion>(
  {
    id: { type: String, required: true },
    question: { type: String, required: true },
    options: { type: [String], required: true },
    correctIndex: { type: Number, required: true },
    explanation: { type: String, required: true },
    sourceLessons: { type: [Number], required: true },
    isInterleaved: { type: Boolean, default: false },
    interleavedModuleIndex: { type: Number, default: undefined },
  },
  { _id: false },
);

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<IModuleQuizContent>(
  {
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    moduleIndex: { type: Number, required: true },
    questions: { type: [questionSchema], default: [] },
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

schema.index({ courseId: 1, moduleIndex: 1 }, { unique: true });

// ── Model ──────────────────────────────────────────────────

const ModuleQuizContentModel = mongoose.model<IModuleQuizContent>('ModuleQuizContent', schema, 'ModuleQuizContent');

export default ModuleQuizContentModel;
