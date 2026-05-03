import mongoose, { HydratedDocument, Schema } from 'mongoose';

// ── Types ──────────────────────────────────────────────────

export interface IProductKbChunk {
  /** Stable namespace tag — always `'product-kb'` in v1; reserved for future
   *  side-by-side corpora (e.g., `'product-kb-staging'`, `'changelog'`). */
  namespace: string;
  /** Article folder under `client/src/content/kb/`. Matches the URL `topic` segment. */
  topic: string;
  /** Article filename without extension. Matches the URL `slug` segment. */
  articleSlug: string;
  /** Frontmatter title — denormalized so search results don't require a second fetch. */
  articleTitle: string;
  /** Optional H2/H3 heading the chunk lives under, dot-joined ("Why retrieval works › The testing effect"). */
  sectionPath: string;
  chunkIndex: number;
  text: string;
  tokenCount: number;
  embeddedAt: Date;
  /** Pinecone vector id, format: `product-kb:${articleSlug}:${chunkIndex}`. */
  vectorId: string;
  /** sha256 over normalized frontmatter+body of the article — diffs against
   *  the manifest decide whether to re-index or skip during script runs. */
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ProductKbChunkDocument = HydratedDocument<IProductKbChunk>;

// ── Schema ─────────────────────────────────────────────────
//
// Mirrors LessonChunkModel: the chunk text + metadata are the source of
// truth in Mongo, while Pinecone holds the vector + minimal filter
// metadata. Search joins by `vectorId`.
//
// Differs from LessonChunkModel only in the corpus identity fields
// (namespace/topic/articleSlug) and in not being scoped to a courseId —
// the product KB is a global corpus.

const schema = new Schema<IProductKbChunk>(
  {
    namespace: { type: String, required: true, maxlength: 64 },
    topic: { type: String, required: true, maxlength: 128 },
    articleSlug: { type: String, required: true, maxlength: 128 },
    articleTitle: { type: String, required: true, maxlength: 200 },
    sectionPath: { type: String, default: '', maxlength: 400 },
    chunkIndex: { type: Number, required: true },
    text: { type: String, required: true, maxlength: 50000 },
    tokenCount: { type: Number, required: true },
    embeddedAt: { type: Date, required: true },
    vectorId: { type: String, required: true, maxlength: 256 },
    contentHash: { type: String, required: true, maxlength: 128 },
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

// Lookup path: search returns vectorIds → fetch by vectorId.
schema.index({ vectorId: 1 }, { unique: true });
// Bulk delete on article re-index (wipe all chunks for one slug before re-chunking).
schema.index({ namespace: 1, articleSlug: 1, chunkIndex: 1 });
// Manifest reconciliation: list every persisted slug + its hash.
schema.index({ namespace: 1, articleSlug: 1 }, { unique: false });

// ── Model ──────────────────────────────────────────────────

const ProductKbChunkModel = mongoose.model<IProductKbChunk>('ProductKbChunk', schema, 'ProductKbChunk');

export default ProductKbChunkModel;
