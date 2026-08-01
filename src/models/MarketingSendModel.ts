import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { MARKETING_CAMPAIGNS, MARKETING_SEND_STATUSES, MarketingCampaign, MarketingSendStatus } from '@lib/constants';

// Per-recipient, per-campaign send ledger — the double-send guard and the
// audit trail for every promotional message we send.
//
// It is a ledger keyed by campaign, not a per-campaign roster: a roster
// carrying only `sentAt` and no campaign key would answer `already_sent` for
// every address on every subsequent campaign.
//
// **The unique `(campaignKey, email)` index is the arbiter**, not application
// code. The send path claims with an upserting `findOneAndUpdate` and maps
// the duplicate-key error to `already_sent`; two admins clicking send at the
// same moment therefore resolve to exactly one message per address, with the
// loser learning it lost from the database rather than from a prior read
// (data-integrity §2, §6).
//
// Two timestamps, deliberately:
//   - `claimedAt` is the CAS field. Set the instant we take the recipient,
//     BEFORE the Mailjet call, and unset again if that call fails, so a
//     transient failure never locks an address out of the campaign.
//   - `sentAt` records confirmed delivery to Mailjet. A row with `claimedAt`
//     and no `sentAt` is an in-flight or **stranded** claim — a process
//     killed between the claim and the send — which is what the
//     `GET /claims` + `POST /reclaim` pair exists to surface and recover
//     (F11). Without the split, a stranded claim is indistinguishable from a
//     successful send and that recipient is silently dropped forever.
//
// PII: `email` (identifier class). Retention: kept until account deletion —
// `deleteAccount` already deletes from this collection by address, which is
// why the collection name below must stay exactly `'MarketingSend'`.
export interface IMarketingSend {
  campaignKey: MarketingCampaign;
  email: string;
  /** The ledger row this send was selected from, when one existed. */
  contactId?: Types.ObjectId;
  status: MarketingSendStatus;
  /** CAS field — set at claim time, unset on rollback. */
  claimedAt?: Date;
  /** Set only once Mailjet has accepted the message. */
  sentAt?: Date;
  sentByUserId?: Types.ObjectId;
  attempts: number;
  /** Vendor-side reason for the last failure. Never contains the address. */
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MarketingSendDocument = HydratedDocument<IMarketingSend>;

const schema = new Schema<IMarketingSend>(
  {
    campaignKey: { type: String, enum: [...MARKETING_CAMPAIGNS], required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'MarketingContact' },
    status: { type: String, enum: [...MARKETING_SEND_STATUSES], required: true },
    claimedAt: { type: Date },
    sentAt: { type: Date },
    sentByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String },
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

// The double-send guard. Everything else in the send path is an optimisation
// on top of this one constraint.
schema.index({ campaignKey: 1, email: 1 }, { unique: true });
// Stranded-claim sweep: `status` + `claimedAt` ordering.
schema.index({ campaignKey: 1, status: 1, claimedAt: 1 });
// Cross-campaign hard-bounce exclusion (PLAN A13) reads by status alone.
schema.index({ status: 1, email: 1 });

const MarketingSendModel = mongoose.model<IMarketingSend>(
  'MarketingSend',
  schema,
  // Must match the literal collection name in the account-deletion cascade
  // (`controlers/auth/deleteAccount.ts`), which reaches this collection
  // through the driver.
  'MarketingSend',
);

export { schema as marketingSendSchema };

export default MarketingSendModel;
