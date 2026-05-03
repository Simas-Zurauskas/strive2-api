import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { JOB_TYPES, JOB_STATUSES, JobType, JobStatus } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

export interface IJob {
  userId: Types.ObjectId;
  courseId: Types.ObjectId;
  type: JobType;
  status: JobStatus;
  error: string | null;
  metadata: Record<string, unknown> | null;
  completedAt: Date | null;
  // Updated periodically while a job is `processing` so a watchdog can detect
  // stuck jobs whose worker crashed without going through the usual
  // `failJob` / `completeJob` exit paths. `null` for `pending` rows that
  // haven't started yet.
  lastHeartbeat: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type JobDocument = HydratedDocument<IJob>;

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<IJob>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [...JOB_TYPES],
      required: true,
    },
    status: {
      type: String,
      enum: [...JOB_STATUSES],
      default: 'pending',
    },
    error: {
      type: String,
      default: null,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    lastHeartbeat: {
      type: Date,
      default: null,
    },
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

schema.index({ userId: 1, courseId: 1 });
schema.index({ completedAt: 1 }, { expireAfterSeconds: 86400 }); // TTL: auto-delete 24h after completion
// Watchdog sweep: find processing jobs whose lastHeartbeat is stale.
// Sparse so pending/done rows (with null heartbeat) aren't indexed.
schema.index({ status: 1, lastHeartbeat: 1 }, { sparse: true });

// ── Model ──────────────────────────────────────────────────

const JobModel = mongoose.model<IJob>('Job', schema, 'Job');

export default JobModel;
