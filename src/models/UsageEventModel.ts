import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { USAGE_SERVICES, UsageService } from '@lib/usageConstants';

// ── Types ──────────────────────────────────────────────────

export interface IUsageEvent {
  userId: Types.ObjectId;
  timestamp: Date;
  service: UsageService;
  /** Stable call-site label, e.g. 'lesson:content', 'image:hero', 'search:advanced'. */
  action: string;
  /** Integer microcents — see `lib/pricing.ts` for the unit rationale. */
  costMicroCents: number;
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
