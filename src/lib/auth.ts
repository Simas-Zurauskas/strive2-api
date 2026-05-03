import { JWT_SECRET } from '@conf/env';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export interface AuthTokenPayload {
  id: string;
  tokenVersion: number;
  iat: number;
  exp: number;
}

// 7-day expiry: cuts the stolen-token exposure window from 30 days to 7 days
// while still long enough to survive most user "go on holiday" scenarios.
// Sliding-refresh: the client (NextAuth jwt callback) calls
// `/api/auth/refresh` BEFORE the token expires to swap in a fresh 7-day
// token without re-authenticating. That swap reads `tokenVersion` from the
// DB, so a stolen token whose tokenVersion has been bumped (logout,
// password change, etc.) refuses to refresh — losing the attacker the
// session even before the access token expires.
//
// Existing tokens retain their original baked-in exp; only newly issued
// tokens get the shorter lifetime.
export const ACCESS_TOKEN_TTL = '7d';

export const generateAuthToken = (params: { id: string; tokenVersion: number }): string => {
  const { id, tokenVersion } = params;
  return jwt.sign({ id, tokenVersion }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' });
};

export const decodeAuthToken = (token: string): AuthTokenPayload | undefined => {
  try {
    // Explicit algorithm allowlist defends against the classic `alg: 'none'`
    // downgrade attack and against key-confusion swaps to asymmetric algorithms.
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as AuthTokenPayload;
  } catch {
    return undefined;
  }
};

export const hashPassword = async (password: string): Promise<string> => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

// ── Email verification tokens ──────────────────────────────

export const VERIFICATION_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Shorter than the email-verification window: a reset link can fully take over
// the account, so the exposure budget is smaller.
export const PASSWORD_RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

export const generateVerificationToken = (): { plainToken: string; hashedToken: string } => {
  const plainToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
  return { plainToken, hashedToken };
};

export const hashVerificationToken = (plainToken: string): string => {
  return crypto.createHash('sha256').update(plainToken).digest('hex');
};
