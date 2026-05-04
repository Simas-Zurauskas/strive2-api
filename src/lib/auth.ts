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

// 30-day expiry. Strive isn't a high-security app — the friction cost of
// forcing re-login on a casual learner who comes back every couple of
// weeks outweighs the marginal security gain of a shorter raw TTL. The
// real defense is `tokenVersion`: every authenticated request re-reads
// it from the DB via `protect`, so logout / password change / explicit
// revocation invalidates every outstanding token *immediately* —
// independent of how long the JWT itself claims to live.
//
// Sliding-refresh: the client (NextAuth jwt callback) calls
// `/api/auth/refresh` when the token is within 7 days of expiring, which
// mints a brand-new 30-day token. So a user who opens the app at least
// once every ~23 days keeps a continuous session indefinitely. Refresh
// re-checks tokenVersion against the DB, so a revoked token (logout,
// password change, etc.) refuses to refresh — the attacker loses the
// session even before the access token's natural expiry.
//
// Existing tokens retain their original baked-in exp; only newly issued
// tokens get the longer lifetime.
export const ACCESS_TOKEN_TTL = '30d';

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

// Cost factor 12 matches OWASP 2024 password-storage guidance on commodity
// hardware. ~250-400 ms per hash on a modern server — fine for login
// frequency. Existing hashes at lower costs keep working: bcrypt embeds
// the cost in the hash string, so `bcrypt.compare` honors the per-row
// cost and only newly-hashed passwords (signup, reset, change) get the
// upgraded cost.
export const hashPassword = async (password: string): Promise<string> => {
  const salt = await bcrypt.genSalt(12);
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
