import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { USAGE_SERVICES, UsageService } from '@lib/usageConstants';
import { PLAN_KEYS, SUBSCRIPTION_STATUSES, PlanKey, SubscriptionStatus } from '@lib/creditPricing';

// ── Types ──────────────────────────────────────────────────

export interface IUsageEvent {
  userId: Types.ObjectId;
  timestamp: Date;
  service: UsageService;
  /** Stable call-site label, e.g. 'lesson:content', 'image:hero', 'search:advanced'. */
  action: string;
  /** Vendor cost: what we actually paid the provider. Integer microcents — see `lib/pricing.ts`. */
  costMicroCents: number;
  /**
   * What we charged the user (vendor cost × any per-service markup; see
   * `applyStaticMarkup` in `lib/pricing.ts`). For services without markup
   * this equals `costMicroCents`. Optional so legacy rows written before the
   * markup feature still load — readers should treat a missing value as
   * equal to `costMicroCents`.
   */
  chargedMicroCents?: number;
  /**
   * The user's plan + subscription status at the moment this row was
   * recorded. Stamped by `recordUsage` from the active `usageContext`
   * scope; absent for rows recorded outside an authenticated/job scope, or
   * for legacy rows pre-dating this field. Used by the engineer billing
   * view to attribute USD-equivalent cost back to the right per-credit rate.
   */
  planAtTime?: PlanKey;
  subscriptionStatusAtTime?: SubscriptionStatus;
  /**
   * Stamp of the pricing config in force when this row was charged
   * (see `PRICING_VERSION` in `lib/pricingConfig.ts`). Lets historical
   * audits, refunds, and billing-dispute lookups know which markup table
   * the row was billed under. Absent for rows recorded before the stamp
   * was introduced (those are pre-2026-05-12 multi-layer pricing).
   */
  pricingVersion?: string;
  /**
   * Free-form per-service payload: model id + token breakdown for LLM rows,
   * url/hostname for fetch/search rows, jobId/courseId/moduleIndex/lessonIndex
   * stamped from the usage-context ALS. Mongoose.Mixed so new services don't
   * require a schema migration to add their own fields.
   */
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type UsageEventDocument = HydratedDocument<IUsageEvent>;

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<IUsageEvent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    timestamp: { type: Date, required: true, default: () => new Date() },
    service: { type: String, enum: [...USAGE_SERVICES], required: true },
    action: { type: String, required: true },
    costMicroCents: { type: Number, required: true, min: 0 },
    chargedMicroCents: { type: Number, min: 0 },
    planAtTime: { type: String, enum: [...PLAN_KEYS] },
    subscriptionStatusAtTime: { type: String, enum: [...SUBSCRIPTION_STATUSES] },
    pricingVersion: { type: String },
    metadata: { type: Schema.Types.Mixed },
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

// Primary query path: "most recent rows for user" (history tab pagination).
schema.index({ userId: 1, timestamp: -1 });
// Secondary: "how much did user X spend on service Y" (summary breakdown).
schema.index({ userId: 1, service: 1, timestamp: -1 });

// ── Model ──────────────────────────────────────────────────

const UsageEventModel = mongoose.model<IUsageEvent>(
  'UsageEvent',
  schema,
  'UsageEvent',
);

export default UsageEventModel;
