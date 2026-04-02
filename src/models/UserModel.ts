import { compare } from 'bcryptjs';
import mongoose, { HydratedDocument, Model, Schema } from 'mongoose';
import { AUTH_PROVIDERS, AuthProvider } from '@lib/constants';

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

/** Persisted user fields (includes system-managed state). */
export interface IUser extends UserInput {
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpiry?: Date;
  passwordResetToken?: string;
  tokenVersion: number;
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
    tokenVersion: { type: Number, default: 0 },
    authProviders: {
      type: [
        {
          provider: {
            type: String,
            enum: [...AUTH_PROVIDERS],
            required: true,
          },
          providerId: { type: String },
        },
      ],
      required: true,
      default: [],
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
        delete ret.__v;
        return ret;
      },
    },
  },
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
