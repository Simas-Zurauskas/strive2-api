import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import {
  SOURCE_DOCUMENT_KINDS,
  SOURCE_DOCUMENT_STATUSES,
  SourceDocumentKind,
  SourceDocumentStatus,
} from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

export interface ISourceDocument {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  kind: SourceDocumentKind;
  /** For `kind: 'url'` — the public article URL the snapshot was fetched from. */
  sourceUrl: string | null;
  filename: string;
  mimeType: string;
  byteSize: number;
  /** Hex sha256 of the raw bytes — dedup key within a course only (never cross-user). */
  sha256: string;
  /** Raw file (or URL snapshot) in S3, under `uploads/{userId}/{courseId}/…`. */
  s3Key: string;
  status: SourceDocumentStatus;
  /** Category-level only (e.g. moderation category) — never echoes content. */
  rejectionReason: string | null;
  pageCount: number | null;
  extractedTokens: number | null;
  /** Pages the scanned-page detector flagged (<~100 extractable chars). */
  scannedPageCount: number | null;
  /** 1-based page numbers already vision-escalated (triage sample or prepare_corpus). */
  escalatedPages: number[];
  audioDurationSec: number | null;
  /** Seconds of audio transcribed so far (free triage window, then prepare_corpus). */
  transcribedSec: number | null;
  /** Parsed artifact in S3 — content-hashed within the course prefix so prefix-delete erasure covers it. */
  parsedS3Key: string | null;
  /**
   * `kind: 'url'` audit trail — which machine-readable rights-reservation
   * signal we honoured at fetch time (`urlReservationCheck.ReservationSignal`:
   * `no_reservation` | `robots_disallow` | `tdm_reservation` | …). Typed as a
   * plain string, not the union: these rows outlive the union, and a signal
   * renamed in a later phase must not retroactively invalidate history.
   * Null on every file document and on every pre-Phase-1 row.
   */
  reservationSignal: string | null;
  /** When that signal was read (may predate the fetch by the gate's cache TTL). */
  reservationCheckedAt: Date | null;
  /**
   * `kind: 'url'` retention marker — when `sweepExpiredUrlSnapshots` erased
   * the fetched page snapshot (the S3 object at `s3Key`, the parsed
   * artifact at `parsedS3Key`, and every derived chunk the course does not
   * cite). Null means the snapshot is still held; non-null means this row
   * survives ONLY as the lineage record ToS §6.2 / Privacy §5 promise to
   * keep (the link, the fetch time, the content fingerprint, the
   * rights-reservation signal, and the cited excerpts).
   *
   * Doubles as the sweep's idempotency key: candidate selection filters on
   * `snapshotDeletedAt: null`, so a second pass over the same row is a
   * no-op. Null on every file document and on every pre-retention row.
   */
  snapshotDeletedAt: Date | null;
  warnings: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type SourceDocumentDocument = HydratedDocument<ISourceDocument>;

// ── Schema ─────────────────────────────────────────────────
//
// The lineage record for every uploaded file / ingested URL: which raw
// bytes live where in S3, what extraction produced, and why a document
// was rejected. It is also the erasure manifest — course deletion and
// account deletion enumerate these rows to wipe S3 objects, chunk rows
// and Pinecone vectors.

const schema = new Schema<ISourceDocument>(
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
    kind: {
      type: String,
      enum: [...SOURCE_DOCUMENT_KINDS],
      required: true,
    },
    sourceUrl: { type: String, default: null, maxlength: 2048 },
    filename: { type: String, required: true, maxlength: 500 },
    mimeType: { type: String, required: true, maxlength: 200 },
    byteSize: { type: Number, required: true },
    sha256: { type: String, required: true, maxlength: 64 },
    s3Key: { type: String, required: true, maxlength: 1024 },
    status: {
      type: String,
      enum: [...SOURCE_DOCUMENT_STATUSES],
      default: 'uploaded',
    },
    rejectionReason: { type: String, default: null, maxlength: 500 },
    pageCount: { type: Number, default: null },
    extractedTokens: { type: Number, default: null },
    scannedPageCount: { type: Number, default: null },
    escalatedPages: { type: [Number], default: [] },
    audioDurationSec: { type: Number, default: null },
    transcribedSec: { type: Number, default: null },
    parsedS3Key: { type: String, default: null, maxlength: 1024 },
    reservationSignal: { type: String, default: null, maxlength: 64 },
    reservationCheckedAt: { type: Date, default: null },
    snapshotDeletedAt: { type: Date, default: null },
    warnings: {
      type: [{ type: String, maxlength: 1000 }],
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

// Course-scoped listing + course-deletion cascade.
schema.index({ courseId: 1 });
// Account-deletion cascade (user-scoped deleteMany).
schema.index({ userId: 1 });
// Dedup within a course (A6: never cross-user/cross-course). File uploads
// dedup on content hash; URL documents dedup on the normalized URL. Both
// are partial so the two kinds never collide with each other, and the
// url index only applies once a real sourceUrl string exists.
// `sourceDocumentService` relies on these for idempotent duplicate
// uploads (E11000 → return the existing row).
schema.index(
  { courseId: 1, sha256: 1 },
  { unique: true, partialFilterExpression: { kind: 'file' } },
);
schema.index(
  { courseId: 1, sourceUrl: 1 },
  { unique: true, partialFilterExpression: { kind: 'url', sourceUrl: { $type: 'string' } } },
);

// ── Model ──────────────────────────────────────────────────

const SourceDocumentModel = mongoose.model<ISourceDocument>(
  'SourceDocument',
  schema,
  'SourceDocument',
);

export default SourceDocumentModel;
