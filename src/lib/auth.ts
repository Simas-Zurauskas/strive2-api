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

// 30-day expiry matches the default NextAuth session lifetime on the client.
// Previously 100d — reduced to shorten the exposure window for stolen tokens.
// Existing tokens retain their original baked-in exp; only newly issued tokens
// get the shorter lifetime. A proper refresh-token flow remains a follow-up.
export const generateAuthToken = (params: { id: string; tokenVersion: number }): string => {
  const { id, tokenVersion } = params;
  return jwt.sign({ id, tokenVersion }, JWT_SECRET, { expiresIn: '30d', algorithm: 'HS256' });
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

export const generateVerificationToken = (): { plainToken: string; hashedToken: string } => {
  const plainToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
  return { plainToken, hashedToken };
};

export const hashVerificationToken = (plainToken: string): string => {
  return crypto.createHash('sha256').update(plainToken).digest('hex');
};
