import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import {
  MARKETING_BASES,
  MARKETING_SOURCES,
  MarketingBasis,
  MarketingSource,
} from '@lib/constants';

// The marketing **audience + lawful-basis + suppression ledger**.
//
// Before this collection existed, "may I email this user?" was answerable
// only by a per-address round trip to Mailjet's Contact DB — which cannot
// be joined against, does not survive a vendor outage, and records no
// basis. GDPR Art. 7(1)/ePrivacy Art. 13(2) both ask a question about a
// point in time ("what were they told, and when?"), so the answer has to
// be a row with a version on it, not a boolean living at a vendor
// (data-protection.md §8.1).
//
// Relationship to Mailjet after this change:
//   - THIS collection decides who is in the audience.
//   - Mailjet remains the delivery-side suppression list, and its
//     hosted-unsubscribe page still writes there. The two are reconciled in
//     one direction only — *toward* suppression: `mailjetSuppressionSync`
//     reads Mailjet's unsubscribed set in bulk and we apply it here, and
//     `syncSuppression` pushes our opt-outs back. Nothing anywhere flips a
//     contact from opted-out to subscribed except the user's own explicit
//     profile toggle (PLAN A2b).
//
// PII: `email` (identifier class) + `userId`. Retention: kept until account
// deletion — the `deleteAccount` cascade removes the row by userId OR email
// so a row seeded before the userId link still goes (F13).
export interface IMarketingContact {
  /** Absent on rows seeded before the user link, or for a user since deleted. */
  userId?: Types.ObjectId;
  email: string;
  basis: MarketingBasis;
  source: MarketingSource;
  /** Notice/memo version the basis rests on — see `MARKETING_EVIDENCE`. */
  evidence: string;
  optedOut: boolean;
  optedOutAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type MarketingContactDocument = HydratedDocument<IMarketingContact>;

const schema = new Schema<IMarketingContact>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    // Unique + lowercase: the audience is keyed on the address, so a
    // case-variant duplicate would be a second, unsuppressable copy of the
    // same person.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    basis: { type: String, enum: [...MARKETING_BASES], required: true },
    source: { type: String, enum: [...MARKETING_SOURCES], required: true },
    evidence: { type: String, required: true },
    // Default false is the only safe default for a NEW row, because a row is
    // only ever created by a path that has already established the basis.
    // It is never used to *reset* an existing row — see the file header.
    optedOut: { type: Boolean, required: true, default: false },
    optedOutAt: { type: Date },
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

// The audience query is `{ optedOut: false }`; index it so the send path
// never table-scans the ledger.
schema.index({ optedOut: 1, email: 1 });
// Deletion cascade lookup.
schema.index({ userId: 1 });

const MarketingContactModel = mongoose.model<IMarketingContact>(
  'MarketingContact',
  schema,
  'MarketingContact',
);

/**
 * The one and only definition of "who may receive a promotional send".
 * Exported as a filter as well as a query so a caller that needs to count
 * or stream cannot accidentally write a *different* predicate — an audience
 * query that forgets `optedOut` is the whole failure this ledger exists to
 * prevent.
 */
export const PROMOTIONAL_AUDIENCE_FILTER = { optedOut: false } as const;

export interface PromotionalAudienceRow {
  _id: Types.ObjectId;
  email: string;
  basis: MarketingBasis;
}

export const findPromotionalAudience = (): Promise<PromotionalAudienceRow[]> =>
  MarketingContactModel.find(PROMOTIONAL_AUDIENCE_FILTER)
    .select('_id email basis')
    .lean<PromotionalAudienceRow[]>()
    .exec();

export { schema as marketingContactSchema };

export default MarketingContactModel;
