import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';

// ── Types ──────────────────────────────────────────────────

/**
 * Persisted record of a user's cookie-consent choice. GDPR Art. 7(1)
 * requires the controller to be able to demonstrate that the data
 * subject consented — localStorage alone fails that test in a regulator
 * complaint ("I never accepted").
 *
 * Anonymous visitors (no userId) are recorded against an
 * `anonymousId` (random uuid persisted by the client). Once they sign up,
 * the anonymousId can be cross-referenced via subsequent records keyed
 * to the authenticated userId.
 *
 * IP is stored truncated (last octet zeroed for IPv4; last 80 bits zeroed
 * for IPv6) — the standard recordkeeping precision for "demonstrate
 * consent" without retaining a precise location signal.
 */
export interface IConsentEvent {
  userId: Types.ObjectId | null;
  anonymousId: string | null;
  value: 'all' | 'essential' | null;
  policyVersion: string;
  ip: string | null;
  userAgent: string | null;
  recordedAt: Date;
}

export type ConsentEventDocument = HydratedDocument<IConsentEvent>;

// ── Schema ─────────────────────────────────────────────────

// 24 months retention. CNIL guidance for consent records is "for as long
// as the data processing it covers continues" — 2y is the typical lower
// bound. Adjust if legal counsel asks.
export const CONSENT_EVENT_RETENTION_DAYS = 730;

const schema = new Schema<IConsentEvent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    anonymousId: { type: String, default: null, index: true },
    value: { type: String, enum: ['all', 'essential', null], default: null },
    policyVersion: { type: String, required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    recordedAt: { type: Date, required: true, default: () => new Date() },
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

// TTL: the record self-destructs 24 months after `recordedAt`. Re-grants
// land as fresh rows so the 24-month window is per-event, not per-user.
schema.index({ recordedAt: 1 }, { expireAfterSeconds: CONSENT_EVENT_RETENTION_DAYS * 24 * 60 * 60 });

// ── Model ──────────────────────────────────────────────────

const ConsentEventModel = mongoose.model<IConsentEvent>(
  'ConsentEvent',
  schema,
  'ConsentEvent',
);

export default ConsentEventModel;
