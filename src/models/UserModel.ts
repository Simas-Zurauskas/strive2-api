import { compare } from 'bcryptjs';
import mongoose, { HydratedDocument, Model, Schema } from 'mongoose';
import { AUTH_PROVIDERS, AuthProvider } from '@lib/constants';
import {
  FREE_PERIOD_DAYS,
  PLAN_KEYS,
  PLANS,
  PlanKey,
  SUBSCRIPTION_STATUSES,
  SubscriptionStatus,
} from '@lib/creditPricing';

const buildFreshFreePeriod = (): { periodStart: Date; periodEnd: Date } => {
  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + FREE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  return { periodStart, periodEnd };
};

export { AuthProvider } from '@lib/constants';

// ── Types ──────────────────────────────────────────────────

/** Fields provided when creating a user. */
export interface UserInput {
  email: string;
  name?: string;
  image?: string;
  password?: string;
  authProviders: {
    provider: AuthProvider;
    providerId?: string;
  }[];
}

export interface IUserSubscription {
  plan: PlanKey;
  status: SubscriptionStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripePriceId?: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd: boolean;
  /** Set when a downgrade is scheduled to apply at next invoice.paid. */
  pendingPlan?: PlanKey;
}

export interface IUserCredits {
  /** Credits from this period's plan allowance. Forfeits at period reset. */
  allowanceBalance: number;
  /** How much was granted at period start (for UI display of "X of Y used"). */
  allowanceGranted: number;
  periodStart: Date;
  periodEnd: Date;
  /** Credits from top-up purchases or admin grants. Never expire. */
  bonusBalance: number;
}

export interface IUserPreferences {
  /**
   * Default Google Cloud TTS voice id for lesson narration (e.g.
   * "en-US-Wavenet-F"). Lesson screen offers a per-lesson override; this
   * field is just the user's "play with what I picked last" default. Empty
   * string ('') means "no preference saved yet" — the server falls back to
   * the catalog default in `lib/narration/voices.ts`.
   */
  narrationVoice: string;
  /**
   * Default TTS playback rate sent to Google (their `speakingRate`,
   * range 0.25–4.0). The lesson player can also adjust client-side
   * playbackRate on the <audio> element; this is the value baked into
   * the synthesised file so it survives across devices.
   */
  narrationRate: number;
}

/** Persisted user fields (includes system-managed state). */
export interface IUser extends UserInput {
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpiry?: Date;
  passwordResetToken?: string;
  passwordResetExpiry?: Date;
  tokenVersion: number;
  /**
   * Hand-flipped admin flag. There is no in-app UI to toggle this — it
   * exists for ops to grant themselves access to engineer-only surfaces
   * (BillingTab → engineer view, the dev "Reset quiz" button, the
   * usage-events delete endpoint, etc.). Default false; only the `_id`s
   * we explicitly set in the DB get true. The `requireAdmin` middleware
   * gates server routes; client UI mirrors the same flag for visibility.
   */
  isAdmin: boolean;
  favoriteCourseIds: mongoose.Types.ObjectId[];
  subscription: IUserSubscription;
  credits: IUserCredits;
  preferences: IUserPreferences;
  createdAt: Date;
  updatedAt: Date;
}

interface IUserMethods {
  comparePassword(password: string): Promise<boolean>;
}

type UserModel = Model<IUser, object, IUserMethods>;

export type UserDocument = HydratedDocument<IUser, IUserMethods>;

const schema = new Schema<IUser, UserModel, IUserMethods>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: { type: String, trim: true },
    image: { type: String },
    password: { type: String, select: false },
    emailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String, select: false },
    emailVerificationExpiry: { type: Date, select: false },
    passwordResetToken: { type: String, select: false },
    passwordResetExpiry: { type: Date, select: false },
    tokenVersion: { type: Number, default: 0 },
    // Default false; flipped by ops directly in the DB. No code path
    // sets this to true.
    isAdmin: { type: Boolean, default: false },
    favoriteCourseIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Course' }],
      default: [],
    },
    authProviders: {
      // `_id: false` prevents Mongoose from auto-generating a per-entry _id.
      // Without this, every push creates a "fresh" subdoc to Mongo's deep
      // equality check, so $addToSet never matches an existing entry and
      // duplicates accumulate on every Google sign-in.
      type: [
        new Schema(
          {
            provider: {
              type: String,
              enum: [...AUTH_PROVIDERS],
              required: true,
            },
            providerId: { type: String },
          },
          { _id: false },
        ),
      ],
      required: true,
      default: [],
    },
    subscription: {
      type: new Schema<IUserSubscription>(
        {
          plan: { type: String, enum: [...PLAN_KEYS], required: true, default: 'free' },
          status: { type: String, enum: [...SUBSCRIPTION_STATUSES], required: true, default: 'active' },
          stripeCustomerId: { type: String },
          stripeSubscriptionId: { type: String },
          stripePriceId: { type: String },
          currentPeriodStart: { type: Date },
          currentPeriodEnd: { type: Date },
          cancelAtPeriodEnd: { type: Boolean, required: true, default: false },
          pendingPlan: { type: String, enum: [...PLAN_KEYS] },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({ plan: 'free', status: 'active', cancelAtPeriodEnd: false }),
    },
    credits: {
      type: new Schema<IUserCredits>(
        {
          allowanceBalance: { type: Number, required: true, default: 0, min: 0 },
          allowanceGranted: { type: Number, required: true, default: 0, min: 0 },
          periodStart: { type: Date, required: true, default: () => new Date() },
          periodEnd: { type: Date, required: true, default: () => new Date() },
          bonusBalance: { type: Number, required: true, default: 0, min: 0 },
        },
        { _id: false },
      ),
      required: true,
      // New users get a full Free-plan allowance with a fresh 30-day window.
      // Migration script does the same for legacy users. Real spend is
      // debited from this subdoc by `debitActualSpend` on job completion.
      default: () => {
        const { periodStart, periodEnd } = buildFreshFreePeriod();
        return {
          allowanceBalance: PLANS.free.monthlyAllowance,
          allowanceGranted: PLANS.free.monthlyAllowance,
          periodStart,
          periodEnd,
          bonusBalance: 0,
        };
      },
    },
    preferences: {
      type: new Schema<IUserPreferences>(
        {
          // Empty string is the "unset" sentinel — the lesson narration
          // job resolves this to the catalog default at synthesis time so
          // we don't pin every legacy user to a voice they never picked.
          // No `required: true` on the string because Mongoose treats the
          // empty string as missing under that validator.
          narrationVoice: { type: String, default: '' },
          // Google's speakingRate range is 0.25–4.0; clamp at the schema
          // so a stale client can't push out-of-range values that would
          // make the synthesis call fail.
          narrationRate: { type: Number, default: 1.0, min: 0.25, max: 4.0 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({ narrationVoice: '', narrationRate: 1.0 }),
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.password;
        delete ret.emailVerificationToken;
        delete ret.emailVerificationExpiry;
        delete ret.passwordResetToken;
        delete ret.passwordResetExpiry;
        // tokenVersion is a server-side session-invalidation counter;
        // clients don't need it and leaking it exposes revocation state.
        delete ret.tokenVersion;
        // Stripe IDs stay server-side. The UI gets its subscription view
        // either from a billing summary endpoint or Stripe Customer Portal.
        const sub = ret.subscription as Record<string, unknown> | undefined;
        if (sub) {
          delete sub.stripeCustomerId;
          delete sub.stripeSubscriptionId;
          delete sub.stripePriceId;
        }
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Phase 3 webhook handlers look up users by Stripe IDs; a unique index
// rejects accidental duplicates (one Stripe customer = one Strive user).
//
// Partial — NOT sparse. A sparse unique index still indexes documents whose
// field is explicitly `null`, so two free/cancelled users (both holding
// `null`) collide with E11000 on subscription cancellation. Filtering on
// `$type: 'string'` indexes only real Stripe IDs; both `null` and absent are
// excluded, so any number of users can have "no subscription".
schema.index(
  { 'subscription.stripeCustomerId': 1 },
  { unique: true, partialFilterExpression: { 'subscription.stripeCustomerId': { $type: 'string' } } },
);
schema.index(
  { 'subscription.stripeSubscriptionId': 1 },
  { unique: true, partialFilterExpression: { 'subscription.stripeSubscriptionId': { $type: 'string' } } },
);

// ── Methods ────────────────────────────────────────────────

schema.methods.comparePassword = async function (password: string): Promise<boolean> {
  if (!this.password || !password) {
    return false;
  }

  return compare(password, this.password).catch(() => false);
};

// ── Model ──────────────────────────────────────────────────

const UserModel = mongoose.model<IUser, UserModel>('User', schema, 'User');

export { schema as userSchema };

export default UserModel;
