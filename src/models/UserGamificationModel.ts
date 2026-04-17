import mongoose, { HydratedDocument, Schema, Types } from 'mongoose';
import { XP_SOURCES, XpSource } from '@lib/gamificationConstants';

// ── Types ──────────────────────────────────────────────────

export interface IEarnedAchievement {
  achievementId: string;
  earnedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface IXpLogEntry {
  date: string; // YYYY-MM-DD
  xp: number;
  source: XpSource;
}

export interface IUserGamification {
  userId: Types.ObjectId;

  // XP & Levels
  totalXp: number;
  level: number;

  // Streaks
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string | null; // YYYY-MM-DD

  // Achievements
  earnedAchievements: IEarnedAchievement[];

  // Activity & XP History
  activeDates: string[]; // YYYY-MM-DD dates the user was active
  xpLog: IXpLogEntry[];

  createdAt: Date;
  updatedAt: Date;
}

export type UserGamificationDocument = HydratedDocument<IUserGamification>;

// ── Sub-schemas ────────────────────────────────────────────

const earnedAchievementSchema = new Schema<IEarnedAchievement>(
  {
    achievementId: { type: String, required: true },
    earnedAt: { type: Date, required: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const xpLogEntrySchema = new Schema<IXpLogEntry>(
  {
    date: { type: String, required: true },
    xp: { type: Number, required: true },
    source: { type: String, enum: [...XP_SOURCES], required: true },
  },
  { _id: false },
);

// ── Schema ─────────────────────────────────────────────────

const schema = new Schema<IUserGamification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // XP & Levels
    totalXp: { type: Number, default: 0 },
    level: { type: Number, default: 1 },

    // Streaks
    currentStreak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    lastActiveDate: { type: String, default: null },

    // Achievements
    earnedAchievements: { type: [earnedAchievementSchema], default: [] },

    // Activity & XP History
    activeDates: { type: [String], default: [] },
    xpLog: { type: [xpLogEntrySchema], default: [] },
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

schema.index({ userId: 1 }, { unique: true });

// ── Model ──────────────────────────────────────────────────

const UserGamificationModel = mongoose.model<IUserGamification>(
  'UserGamification',
  schema,
  'UserGamification',
);

export default UserGamificationModel;
