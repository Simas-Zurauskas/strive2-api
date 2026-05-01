import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';

// ── Types ──────────────────────────────────────────────────

export interface ILessonChunk {
  courseId: Types.ObjectId;
  moduleIndex: number;
  lessonIndex: number;
  chunkIndex: number;
  blockId: string;
  blockType: string;
  text: string;
  tokenCount: number;
  embeddedAt: Date;
  /** Pinecone vector id, format: `${courseId}:${moduleIndex}:${lessonIndex}:${chunkIndex}`. */
  vectorId: string;
  createdAt: Date;
  updatedAt: Date;
}

export type LessonChunkDocument = HydratedDocument<ILessonChunk>;

// ── Schema ─────────────────────────────────────────────────
//
// Source-of-truth store for the chunk text. Pinecone holds the vector +
// minimal metadata (just enough to filter), and the search path joins
// vector hits back to this collection by `vectorId` to recover the full
// chunk text. This split lets us re-embed (or migrate to a different
// vector store) without re-chunking, and survives a Pinecone outage —
// chunks remain queryable, just not via similarity.

const schema = new Schema<ILessonChunk>(
  {
    courseId: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    moduleIndex: { type: Number, required: true },
    lessonIndex: { type: Number, required: true },
    chunkIndex: { type: Number, required: true },
    blockId: { type: String, required: true, maxlength: 200 },
    blockType: { type: String, required: true, maxlength: 32 },
    // Chunk size is bounded by the splitter (~1500 chars target, hard cap
    // matches LessonContent.blocks 50000 to allow whole-block fallback).
    text: { type: String, required: true, maxlength: 50000 },
    tokenCount: { type: Number, required: true },
    embeddedAt: { type: Date, required: true },
    vectorId: { type: String, required: true, maxlength: 256 },
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

// Lookup path: search returns vectorIds → fetch by vectorId in one query.
schema.index({ vectorId: 1 }, { unique: true });
// Bulk delete on lesson regeneration — wipe all chunks for a (course, mod, lesson).
schema.index({ courseId: 1, moduleIndex: 1, lessonIndex: 1, chunkIndex: 1 });

// ── Model ──────────────────────────────────────────────────

const LessonChunkModel = mongoose.model<ILessonChunk>('LessonChunk', schema, 'LessonChunk');

export default LessonChunkModel;
