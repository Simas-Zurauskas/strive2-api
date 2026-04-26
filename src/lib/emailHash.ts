import { createHash } from 'node:crypto';
import { JWT_SECRET } from '@conf/env';
import { canonicalizeEmail } from './emailCanonicalize';

/**
 * One-way SHA-256 hash of the canonicalized email, salted with JWT_SECRET.
 *
 * Pseudonymous under GDPR: cannot be reversed without the plaintext email,
 * and the salt binds the hash to this deployment so leaked hashes from a
 * different system can't be correlated. Used as an abuse-log lookup key
 * that survives account deletion without retaining PII.
 *
 * If JWT_SECRET rotates, existing abuse-log hashes become orphaned (no re-
 * match possible). Acceptable — at worst, previously-blocked canonical
 * emails get a fresh free grant until the 12-month retention window expires.
 */
export const hashCanonicalEmail = (email: string): string => {
  const canonical = canonicalizeEmail(email);
  return createHash('sha256').update(`${canonical}::${JWT_SECRET}`).digest('hex');
};
