import { createHmac, timingSafeEqual } from 'node:crypto';
import { JWT_SECRET } from '@conf/env';

// Unsubscribe token for the public, session-less opt-out route (PLAN A12).
//
// Shape: `<contactId>.<base64url HMAC-SHA256>` over `<purpose>.<contactId>`.
//
// Why an HMAC over the id rather than a stored random token:
//   - Any send path can reproduce the link from the contact row alone, so
//     there is no plaintext secret at rest and no second table to keep in
//     step with the ledger.
//   - Nothing is stored, so nothing leaks: a database read gives an
//     attacker contact ids, not working opt-out links.
//
// Scope, stated per security.md §1:
//   - Boundary guarded: the unauthenticated `POST/GET /api/auth/marketing/
//     unsubscribe` route, which mutates exactly one contact's `optedOut`.
//   - Credential: this token, carried in the URL of a marketing email.
//   - Blast radius if forged: one contact is marked unsubscribed. There is
//     no read, no session, and no path back to subscribed — the failure
//     direction is *more* suppression, never less. That asymmetry is why a
//     non-expiring token is acceptable here and would not be elsewhere: a
//     stale link must keep working, because an opt-out link that expired is
//     an opt-out we failed to honour.
//
// Rotation coupling (security.md §6): the key is `JWT_SECRET`, which this
// deployment already reuses for session signing and the abuse-log email
// hash. Rotating it invalidates every previously mailed unsubscribe link in
// addition to every session. Accepted deliberately — the profile toggle is
// an always-available second opt-out path, so a dead link degrades to one
// extra click rather than to an unhonourable request. The `PURPOSE` prefix
// below is what keeps this HMAC domain from colliding with the others.
const PURPOSE = 'marketing-unsub.v1';

const SEPARATOR = '.';

/** 24-hex Mongo ObjectId. Checked before the HMAC so a junk id never
 *  reaches the hash, and so a verified token always names a real id shape. */
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/** Signatures are a fixed 43 chars (base64url of 32 bytes). Anything longer
 *  is rejected before hashing so an attacker cannot push unbounded input
 *  through the HMAC. */
const MAX_TOKEN_LENGTH = 128;

const sign = (contactId: string): string =>
  createHmac('sha256', JWT_SECRET).update(`${PURPOSE}${SEPARATOR}${contactId}`).digest('base64url');

/** Absolute mount path of the unsubscribe route. Exported so the email
 *  builder and the `List-Unsubscribe` header cannot drift into two copies. */
export const MARKETING_UNSUB_PATH = '/api/auth/marketing/unsubscribe';

export const buildMarketingUnsubToken = (contactId: string): string =>
  `${contactId}${SEPARATOR}${sign(contactId)}`;

/**
 * Returns the contact id the token authorises, or `null` for anything that
 * does not verify. Callers MUST treat `null` as "do nothing, answer exactly
 * as you would have on success" — the route must not become an
 * address-existence oracle (security.md §5.5).
 */
export const verifyMarketingUnsubToken = (token: unknown): string | null => {
  if (typeof token !== 'string') return null;
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;

  const idx = token.indexOf(SEPARATOR);
  if (idx <= 0 || idx === token.length - 1) return null;

  const contactId = token.slice(0, idx);
  if (!OBJECT_ID_RE.test(contactId)) return null;

  const provided = Buffer.from(token.slice(idx + 1));
  const expected = Buffer.from(sign(contactId));
  // Length check first: timingSafeEqual throws on a length mismatch, and
  // the length of an HMAC digest is public anyway.
  if (provided.length !== expected.length) return null;

  return timingSafeEqual(provided, expected) ? contactId : null;
};
