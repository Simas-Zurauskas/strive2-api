import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';

// Roster of addresses from the original Strive that we intend to mail the
// relaunch announcement to. One row per email. The admin tab in the client
// reads this collection to render the send list and flips `sentAt` once the
// Mailjet round-trip succeeds — so the same address can't be mailed twice
// from the UI by mistake.
//
// Decoupled from `User` because the original-Strive list was migrated from a
// dump file (`wiki/working/prod.User.json`); not every address has a User
// row in this database, and we don't want to back-populate orphan Users.

export interface IRelaunchRecipient {
  email: string;
  sentAt?: Date;
  /** Admin user id who triggered the send — useful for ops audit. */
  sentByUserId?: Types.ObjectId;
  /** Free-form source tag for the import (e.g. `prod.User.json:2026-05-13`). */
  importSource?: string;
  /**
   * True if this address paid for the original Strive — drives the
   * "Paying" filter in the admin tab and lets the operator route them to
   * the apology/thank-you template instead of the standard relaunch copy.
   */
  wasPayingUser?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type RelaunchRecipientDocument = HydratedDocument<IRelaunchRecipient>;

const schema = new Schema<IRelaunchRecipient>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    sentAt: { type: Date },
    sentByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    importSource: { type: String },
    wasPayingUser: { type: Boolean, default: false },
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

// Send-list pagination + the FE's "show pending vs sent" filter both want a
// quick lookup by sent status. `sentAt` is sparse-indexed since pending rows
// have it unset.
schema.index({ sentAt: 1 });
// "Paying-only" filter on the admin tab. Partial index keeps it small since
// only a few hundred of the 3000+ rows have the flag set.
schema.index({ wasPayingUser: 1 }, { partialFilterExpression: { wasPayingUser: true } });

const RelaunchRecipientModel = mongoose.model<IRelaunchRecipient>(
  'RelaunchRecipient',
  schema,
  'RelaunchRecipient',
);

export default RelaunchRecipientModel;
