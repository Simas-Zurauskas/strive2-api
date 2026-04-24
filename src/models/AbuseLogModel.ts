import mongoose, { HydratedDocument, Schema } from 'mongoose';

// ── Types ──────────────────────────────────────────────────

export interface IAbuseLog {
  /**
   * SHA-256 hex digest of `canonicalizeEmail(email) + "::" + JWT_SECRET`.
   * One-way; no plaintext email retained. See `lib/emailHash.ts`.
   */
  emailHash: string;
  firstSeenAt: Date;
  lastSignupAt: Date;
  signupCount: number;
  lifetimeCreditsGranted: number;
  lifetimeCreditsConsumed: number;
  /**
   * Retention deadline — entries past this date are eligible for purge. Set
   * to 12 months past `lastSignupAt` on every upsert; a background job (or
   * on-access sweep) deletes expired rows so we don't retain abuse data
   * indefinitely without legal basis.
   */
  retentionUntil: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type AbuseLogDocument = HydratedDocument<IAbuseLog>;

// ── Schema ─────────────────────────────────────────────────

export const ABUSE_LOG_RETENTION_DAYS = 365;

const schema = new Schema<IAbuseLog>(
  {
    emailHash: { type: String, required: true, unique: true, index: true },
    firstSeenAt: { type: Date, required: true, default: () => new Date() },
    lastSignupAt: { type: Date, required: true, default: () => new Date() },
    signupCount: { type: Number, required: true, default: 0, min: 0 },
    lifetimeCreditsGranted: { type: Number, required: true, default: 0, min: 0 },
    lifetimeCreditsConsumed: { type: Number, required: true, default: 0, min: 0 },
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

// TTL index: Mongo auto-purges entries once `retentionUntil` is in the past.
// `expireAfterSeconds: 0` means "delete at the timestamp value." GDPR-friendly
// — abuse data self-destructs at the 12-month mark without manual sweeps.
schema.index({ retentionUntil: 1 }, { expireAfterSeconds: 0 });

// ── Model ──────────────────────────────────────────────────

const AbuseLogModel = mongoose.model<IAbuseLog>(
  'AbuseLog',
  schema,
  'AbuseLog',
);

export default AbuseLogModel;
