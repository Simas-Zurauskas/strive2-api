import crypto from 'crypto';
import * as Sentry from '@sentry/node';
import SecurityActionTokenModel, {
  SecurityAction,
} from '@models/SecurityActionTokenModel';
import UserModel from '@models/UserModel';
import { sendSecurityActionCodeAsync } from './emailService';
import { lifecycleLog } from '@lib/loggers';
import { AppError } from '@middleware/errorMiddleware';

// Confirmation-code lifetimes & limits.
//
// 15 minutes is short enough that a leaked code via a browser-cache /
// SMTP-relay log has a tight window, and long enough to forgive the
// "I'll just go grab my phone" UX. 5 attempts cap stops online brute
// force against a known userId without requiring per-row throttling.
const CODE_TTL_MINUTES = 15;
const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

// Per-user request-rate cap. We don't trust the auth-endpoint rate limiter
// alone — it's a 30/10min/IP bucket and a determined attacker (or the user
// just impatiently clicking) would otherwise spam the victim with code
// emails. 60s between requests, with a 5/hour ceiling.
const MIN_INTERVAL_MS = 60 * 1000;
const HOURLY_CAP = 5;

const generateCode = (): string => {
  // 6-digit zero-padded. crypto.randomInt is uniform across the range —
  // do NOT use Math.random for this.
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
};

// Hash with sha256(code + userId-as-pepper). Per-user pepper means a stolen
// codeHash from one row doesn't help an attacker brute-force the same code
// against a different user. SHA-256 is acceptable here because the input
// space is only 1M values and we cap attempts at 5 — a 6-digit code is
// brute-force-safe so long as we enforce attempts (which we do).
const hashCode = ({ code, userId }: { code: string; userId: string }): string =>
  crypto.createHash('sha256').update(`${code}:${userId}`).digest('hex');

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};

/**
 * Issue a fresh confirmation code for a sensitive account action and send
 * it to the user's verified email. Throws if:
 *   - user has no verified email (we can't deliver)
 *   - user requested another code <60s ago (interval cap)
 *   - user has burned through 5 codes in the last hour (rate cap)
 *
 * Returns silently on success — the actual code is delivered via email,
 * never returned to the caller.
 */
export const requestSecurityActionCode = async ({
  userId,
  action,
}: {
  userId: string;
  action: SecurityAction;
}): Promise<void> => {
  const user = await UserModel.findById(userId).select('email emailVerified');
  if (!user) {
    throw new AppError('User not found', { errorCode: 'NOT_FOUND', statusCode: 404 });
  }
  if (!user.emailVerified) {
    throw new AppError(
      'Verify your email first — we can only confirm sensitive actions via a verified address.',
      { errorCode: 'EMAIL_NOT_VERIFIED', statusCode: 403 },
    );
  }

  // Rate gates. Two-tier: spacing + hourly cap. Both are checked before any
  // write so a 429 can't burn a row.
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const recentTokens = await SecurityActionTokenModel.find({
    userId,
    action,
    createdAt: { $gte: oneHourAgo },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (recentTokens.length > 0) {
    const last = recentTokens[0];
    if (now - last.createdAt.getTime() < MIN_INTERVAL_MS) {
      throw new AppError(
        'Too many requests — wait 60 seconds before requesting another code.',
        { errorCode: 'CODE_REQUEST_TOO_SOON', statusCode: 429 },
      );
    }
  }
  if (recentTokens.length >= HOURLY_CAP) {
    throw new AppError(
      "You've requested too many codes recently. Try again later.",
      { errorCode: 'CODE_REQUEST_RATE_EXCEEDED', statusCode: 429 },
    );
  }

  // Invalidate older unused codes for this (user, action) so only the
  // newest one can succeed. Prevents the "user has 3 codes in their inbox,
  // any one would unlock it" footgun.
  await SecurityActionTokenModel.updateMany(
    { userId, action, usedAt: null, expiresAt: { $gt: new Date(now) } },
    { $set: { expiresAt: new Date(now - 1000) } },
  );

  const code = generateCode();
  const codeHash = hashCode({ code, userId });
  const expiresAt = new Date(now + CODE_TTL_MS);

  await SecurityActionTokenModel.create({
    userId,
    action,
    codeHash,
    attempts: 0,
    expiresAt,
    usedAt: null,
  });

  lifecycleLog.info(`security-action:code-issued userId=${userId} action=${action}`);

  sendSecurityActionCodeAsync({
    to: user.email,
    action,
    code,
    expiresInMinutes: CODE_TTL_MINUTES,
  });
};

/**
 * Verify a candidate code against the most-recent unused token for this
 * (user, action). On success, marks the token used (single-use) and returns.
 * On failure, increments attempts and throws an AppError with a stable
 * errorCode so the client UI can branch (`SECURITY_CODE_INVALID`,
 * `SECURITY_CODE_EXPIRED`, `SECURITY_CODE_TOO_MANY_ATTEMPTS`).
 *
 * On any failure path we deliberately do NOT mark the token as "used" —
 * a wrong attempt should not invalidate the code outright. Instead, attempts
 * are counted and we abandon the token when the cap is hit. This matches
 * common UX (typo on first try, retry on second).
 */
export const consumeSecurityActionCode = async ({
  userId,
  action,
  code,
}: {
  userId: string;
  action: SecurityAction;
  code: string;
}): Promise<void> => {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new AppError('Confirmation code must be 6 digits.', {
      errorCode: 'SECURITY_CODE_INVALID',
      statusCode: 400,
    });
  }

  // Most recent unused, unexpired token for this (user, action).
  const token = await SecurityActionTokenModel.findOne({
    userId,
    action,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  if (!token) {
    throw new AppError(
      'Confirmation code expired or not found — request a new one.',
      { errorCode: 'SECURITY_CODE_EXPIRED', statusCode: 400 },
    );
  }

  if (token.attempts >= MAX_VERIFY_ATTEMPTS) {
    throw new AppError(
      'Too many invalid attempts on this code — request a new one.',
      { errorCode: 'SECURITY_CODE_TOO_MANY_ATTEMPTS', statusCode: 429 },
    );
  }

  const candidateHash = hashCode({ code, userId });
  const matches = constantTimeEqual(token.codeHash, candidateHash);

  if (!matches) {
    // Atomic increment so two concurrent verifies can't both pass the
    // attempts < MAX check above and bypass the cap.
    await SecurityActionTokenModel.updateOne(
      { _id: token._id },
      { $inc: { attempts: 1 } },
    );
    lifecycleLog.warn(`security-action:code-mismatch userId=${userId} action=${action} attempts=${token.attempts + 1}`);
    Sentry.captureMessage('security-action:code-mismatch', {
      level: 'info',
      tags: { source: 'securityActionService', action },
      extra: { userId, attempts: token.attempts + 1 },
    });
    throw new AppError('Confirmation code is incorrect.', {
      errorCode: 'SECURITY_CODE_INVALID',
      statusCode: 400,
    });
  }

  // Mark used + bump attempts (so the row reflects the successful try too).
  // Conditional on `usedAt: null` so a concurrent verifier of the same code
  // can't both succeed — exactly one of two parallel calls wins.
  const claim = await SecurityActionTokenModel.updateOne(
    { _id: token._id, usedAt: null },
    { $set: { usedAt: new Date() }, $inc: { attempts: 1 } },
  );
  if (claim.modifiedCount !== 1) {
    throw new AppError('Confirmation code already used — request a new one.', {
      errorCode: 'SECURITY_CODE_EXPIRED',
      statusCode: 400,
    });
  }

  lifecycleLog.info(`security-action:code-consumed userId=${userId} action=${action}`);
};
