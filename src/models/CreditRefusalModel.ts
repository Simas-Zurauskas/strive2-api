import mongoose, { HydratedDocument, Schema } from 'mongoose';

// ── Types ──────────────────────────────────────────────────

/**
 * One row per credit-gate refusal — a user asked for metered work and was
 * told no because their balance was below 1.
 *
 * Why this exists: `requireCredits` previously wrote the refusal to
 * `monetizationLog` and nothing else, so the question "did users churn
 * because they hit the wall, or because they lost interest?" had never been
 * counted even once. A refusal is the only clean *revealed-demand* signal in
 * the system: the user actively asked for more and was blocked. Volunteered
 * abandonment (leaving with balance to spare) means something entirely
 * different, and the two are indistinguishable without this row.
 *
 * Deliberately NOT part of the billing audit trail — `CreditLedger` records
 * what was charged, and a refusal charges nothing. Keeping them apart stops a
 * behavioural metric from polluting the financial record.
 */
export interface ICreditRefusal {
  userId: mongoose.Types.ObjectId;
  /** Plan at the moment of refusal — free/starter/pro/studio churn differently. */
  plan: string;
  /**
   * `METHOD /path` of the blocked request, truncated to 512 chars by the
   * caller. Attacker-influenced (it is `req.originalUrl`) so it is stored as
   * an inert string and never interpolated into a query or template.
   */
  path: string;
  /** Credits the gate demanded — always 1 today; recorded so it stays readable if the gate changes. */
  need: number;
  /** Balance the user actually had. Fractional values are possible. */
  have: number;
  createdAt: Date;
  updatedAt: Date;
}

export type CreditRefusalDocument = HydratedDocument<ICreditRefusal>;

// ── Schema ─────────────────────────────────────────────────

/** Long enough to answer "was the wall binding?" across a full billing cycle. */
export const CREDIT_REFUSAL_RETENTION_DAYS = 180;

/** Truncation bound for `path`. Enforced in code, never as a validator — see below. */
export const CREDIT_REFUSAL_PATH_MAX = 512;

const schema = new Schema<ICreditRefusal>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    plan: { type: String, required: true },
    // No `maxlength` validator on purpose. The write is fire-and-forget and
    // error-swallowed (a metric must never break a request), so a validator
    // would silently drop exactly the longest, most anomalous URLs — the ones
    // most worth seeing. The caller truncates instead.
    path: { type: String, required: true },
    need: { type: Number, required: true, min: 0 },
    have: { type: Number, required: true, min: 0 },
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

// Reporting shape: "refusals for this user over time" and "refusals in a window".
schema.index({ userId: 1, createdAt: -1 });

// TTL: rows self-purge at the retention mark, matching the AbuseLog pattern.
schema.index({ createdAt: 1 }, { expireAfterSeconds: CREDIT_REFUSAL_RETENTION_DAYS * 24 * 60 * 60 });

// ── Model ──────────────────────────────────────────────────

// Third arg pins the collection name. Without it mongoose pluralises to
// `creditrefusals`, which would be the only lower-case collection in a
// database where every other one is PascalCase singular (`User`, `Course`,
// `AbuseLog`, …). Caught by the P5 end-to-end walk, not by any unit test.
const CreditRefusalModel =
  (mongoose.models.CreditRefusal as mongoose.Model<ICreditRefusal>) ||
  mongoose.model<ICreditRefusal>('CreditRefusal', schema, 'CreditRefusal');

export default CreditRefusalModel;
