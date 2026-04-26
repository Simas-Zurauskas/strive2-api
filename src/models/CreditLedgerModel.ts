import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';

// ── Types ──────────────────────────────────────────────────

export const CREDIT_LEDGER_REASONS = [
  'signup_grant',
  'period_reset',
  'plan_upgrade_bonus',
  'topup_purchase',
  'debit_action',
  'refund_job_failed',
  'refund_job_canceled',
  'refund_cross_period',
  'refund_topup',
  'dispute_clawback',
  'admin_grant',
  'admin_clawback',
] as const;

export type CreditLedgerReason = (typeof CREDIT_LEDGER_REASONS)[number];

export interface ICreditLedger {
  userId: Types.ObjectId;
  timestamp: Date;
  /** Signed delta: negative debits, positive grants/refunds. Sums of allowanceDelta + bonusDelta. */
  delta: number;
  allowanceDelta: number;
  bonusDelta: number;
  balanceBefore: number;
  balanceAfter: number;
  bonusBefore: number;
  bonusAfter: number;
  reason: CreditLedgerReason;
  /** e.g. 'lesson_full', 'course_design'. Present on debit/refund rows. */
  actionType?: string;
  jobId?: Types.ObjectId;
  /** Stripe webhook idempotency — unique sparse index rejects double-inserts. */
  stripeEventId?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CreditLedgerDocument = HydratedDocument<ICreditLedger>;

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<ICreditLedger>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    timestamp: { type: Date, required: true, default: () => new Date() },
    delta: { type: Number, required: true },
    allowanceDelta: { type: Number, required: true, default: 0 },
    bonusDelta: { type: Number, required: true, default: 0 },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    bonusBefore: { type: Number, required: true },
    bonusAfter: { type: Number, required: true },
    reason: { type: String, enum: [...CREDIT_LEDGER_REASONS], required: true },
    actionType: { type: String },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job' },
    stripeEventId: { type: String },
    notes: { type: String },
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

// User-facing history pagination.
schema.index({ userId: 1, timestamp: -1 });
// Refund lookups by job.
schema.index({ jobId: 1 }, { sparse: true });
// Stripe webhook idempotency — a duplicate event insert throws E11000 which
// Phase 3 webhook handlers treat as "already processed, skip."
schema.index({ stripeEventId: 1 }, { unique: true, sparse: true });

// ── Model ──────────────────────────────────────────────────

const CreditLedgerModel = mongoose.model<ICreditLedger>(
  'CreditLedger',
  schema,
  'CreditLedger',
);

export default CreditLedgerModel;
