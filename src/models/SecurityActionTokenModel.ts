import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';

// Sensitive-action gate. Actions that mutate account state in irreversible
// ways (password rotation, account deletion) require a fresh email-delivered
// 6-digit code in addition to the bearer token. A stolen JWT alone cannot
// take over the account or wipe its data.
//
// The plaintext code is never stored — only the SHA-256 hash. Verification
// re-hashes the candidate and compares against the stored value.
//
// Lifetime is bounded both by the schema TTL (auto-deletes 30 minutes after
// `expiresAt`) and by the per-row `attempts` cap enforced in the service.
// Single-use: `usedAt` is set on first successful verification so the same
// code can't replay.

export const SECURITY_ACTIONS = ['set_password', 'change_password', 'delete_account'] as const;
export type SecurityAction = (typeof SECURITY_ACTIONS)[number];

export interface ISecurityActionToken {
  userId: Types.ObjectId;
  action: SecurityAction;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SecurityActionTokenDocument = HydratedDocument<ISecurityActionToken>;

const schema = new Schema<ISecurityActionToken>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: [...SECURITY_ACTIONS],
      required: true,
    },
    codeHash: {
      type: String,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    usedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// TTL: auto-delete 30 minutes after the row's expiresAt so the collection
// stays small. Mongo's TTL monitor runs once per minute; we add a small
// margin so the row is still findable for "expired but not yet swept" debug.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 60 });

// Used by the service when looking up the most recent unused token for a
// (user, action) pair.
schema.index({ userId: 1, action: 1, createdAt: -1 });

const SecurityActionTokenModel = mongoose.model<ISecurityActionToken>(
  'SecurityActionToken',
  schema,
  'SecurityActionToken',
);

export default SecurityActionTokenModel;
