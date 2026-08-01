import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';

// ── Types ──────────────────────────────────────────────────

/**
 * Admin-only audit row written by the CSAM hash-screen stage
 * (`services/hashScreen.ts`) when a provider hash-match fires (plan §3.5).
 *
 * Deliberately has NO user-facing surface: it is not in the OpenAPI
 * schema, no route returns it, and nothing about the detection is ever
 * disclosed to the uploader (their document shows the opaque generic
 * `rejectionReason: 'policy'`). Reporting to NCMEC follows the L1
 * runbook, driven by a human reading these rows.
 */
export interface IContentFlag {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  documentId: Types.ObjectId;
  provider: 'photodna';
  /**
   * Minimal provider match metadata (tracking/content ids, status code) —
   * NEVER content, hashes of content, or anything reconstructible.
   */
  matchMeta: Record<string, unknown>;
  /** Where the flagged object was moved (`quarantine/{userId}/{documentId}`). */
  s3QuarantineKey: string;
  /**
   * Retention deadline — REPORT Act requires flagged-material evidence be
   * preserved for 1 year; rows self-destruct after via the TTL index
   * (AbuseLogModel pattern). The quarantined S3 object itself is excluded
   * from every prefix-wipe and cleaned up manually per the runbook.
   */
  retentionUntil: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ContentFlagDocument = HydratedDocument<IContentFlag>;

// ── Schema ─────────────────────────────────────────────────

/** REPORT Act (18 U.S.C. §2258A) evidence-retention window: 1 year. */
export const CONTENT_FLAG_RETENTION_DAYS = 365;

const schema = new Schema<IContentFlag>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    courseId: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'SourceDocument', required: true },
    provider: { type: String, enum: ['photodna'], required: true },
    matchMeta: { type: Schema.Types.Mixed, default: {} },
    s3QuarantineKey: { type: String, required: true, maxlength: 1024 },
    retentionUntil: { type: Date, required: true },
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

// Admin triage lookups.
schema.index({ userId: 1 });
schema.index({ documentId: 1 });

// TTL: Mongo auto-purges rows once `retentionUntil` passes (the 1-year
// REPORT Act window). `expireAfterSeconds: 0` = "delete at the timestamp".
schema.index({ retentionUntil: 1 }, { expireAfterSeconds: 0 });

// ── Model ──────────────────────────────────────────────────

const ContentFlagModel = mongoose.model<IContentFlag>(
  'ContentFlag',
  schema,
  'ContentFlag',
);

export default ContentFlagModel;
