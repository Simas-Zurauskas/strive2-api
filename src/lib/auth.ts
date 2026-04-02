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

export const generateAuthToken = (params: { id: string; tokenVersion: number }): string => {
  const { id, tokenVersion } = params;
  return jwt.sign({ id, tokenVersion }, JWT_SECRET, { expiresIn: '100d' });
};

export const decodeAuthToken = (token: string): AuthTokenPayload | undefined => {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
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
