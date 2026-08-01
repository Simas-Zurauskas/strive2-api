import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { SOURCE_CHUNK_TYPES, SourceChunkType } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

export interface ISourceDocumentChunk {
  /** Per-user isolation rides on this (Pinecone metadata mirrors it) — unlike LessonChunk, documents are personal data. */
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  documentId: Types.ObjectId;
  chunkIndex: number;
  chunkType: SourceChunkType;
  text: string;
  /** Document heading trail down to this chunk, outermost first. */
  headingPath: string[];
  /** 1-based inclusive page span the chunk was extracted from (null for pageless formats). */
  pageRange: { start: number; end: number } | null;
  /** Pinecone vector id, format: `doc:${courseId}:${documentId}:${chunkIndex}`. */
  vectorId: string;
  createdAt: Date;
  updatedAt: Date;
}

export type SourceDocumentChunkDocument = HydratedDocument<ISourceDocumentChunk>;

// ── Schema ─────────────────────────────────────────────────
//
// Mirrors LessonChunkModel: source-of-truth store for the chunk text.
// Pinecone holds the vector + minimal metadata (just enough to filter),
// and the search path joins vector hits back to this collection by
// `vectorId`. The rows double as the Pinecone deletion manifest —
// serverless Pinecone deletes by explicit id only, so losing these rows
// orphans the vectors permanently.

const schema = new Schema<ISourceDocumentChunk>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    courseId: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'SourceDocument', required: true },
    chunkIndex: { type: Number, required: true },
    chunkType: {
      type: String,
      enum: [...SOURCE_CHUNK_TYPES],
      required: true,
    },
    // Chunk size is bounded by the splitter (~1500 chars target); the hard
    // cap allows whole-table/figure fallback, matching LessonChunk.
    text: { type: String, required: true, maxlength: 50000 },
    headingPath: {
      type: [{ type: String, maxlength: 500 }],
      default: [],
    },
    pageRange: {
      type: new Schema(
        {
          start: { type: Number, required: true },
          end: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
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
// Wipe-then-write on re-ingest — delete all chunks for a (course, document).
schema.index({ courseId: 1, documentId: 1, chunkIndex: 1 });
// Account-deletion cascade (user-scoped deleteMany).
schema.index({ userId: 1 });

// ── Model ──────────────────────────────────────────────────

const SourceDocumentChunkModel = mongoose.model<ISourceDocumentChunk>(
  'SourceDocumentChunk',
  schema,
  'SourceDocumentChunk',
);

export default SourceDocumentChunkModel;
