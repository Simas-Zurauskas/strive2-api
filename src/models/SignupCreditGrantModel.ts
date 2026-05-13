import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';

// Pre-provisioned credit grants keyed by email. When a matching email signs
// up (or first signs in via Google), the signup flow looks up this row,
// awards `usdAmount` worth of bonus credits to the new User, and stamps
// `consumedAt` so the same grant can't be claimed twice (and so a re-signup
// after deletion doesn't double-dip).
//
// We keep the row after consumption rather than deleting it: the bonus is
// also recorded in CreditLedger, but holding the consumption stamp here lets
// ops answer "did this email ever have a grant?" without a ledger scan.

export interface ISignupCreditGrant {
  email: string;
  /** Dollar amount the user should receive in bonus credits. Awarded once. */
  usdAmount: number;
  /** Set when a user has signed up with this email and the grant landed. */
  consumedAt?: Date;
  consumedByUserId?: Types.ObjectId;
  /** Free-form source tag for the import. */
  importSource?: string;
  /** Optional human note (e.g. "old-user relaunch") for ops audit. */
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type SignupCreditGrantDocument = HydratedDocument<ISignupCreditGrant>;

const schema = new Schema<ISignupCreditGrant>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    usdAmount: { type: Number, required: true, min: 0 },
    consumedAt: { type: Date },
    consumedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    importSource: { type: String },
    reason: { type: String },
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

// "Pending only" filter (admin UI) and the signup-time lookup both query by
// `email` + unconsumed state. The unique index on email already covers the
// equality match — this partial index narrows the working set during sweeps.
schema.index({ consumedAt: 1 }, { sparse: true });

const SignupCreditGrantModel = mongoose.model<ISignupCreditGrant>(
  'SignupCreditGrant',
  schema,
  'SignupCreditGrant',
);

export default SignupCreditGrantModel;
