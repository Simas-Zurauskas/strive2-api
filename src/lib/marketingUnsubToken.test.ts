/**
 * Tests for the marketing unsubscribe token (PLAN A12 / F1).
 *
 * The token is the ONLY credential on a public, session-less route that
 * mutates a user's marketing state, so three properties are load-bearing:
 *   1. it validates only when untampered,
 *   2. it is scoped to exactly one contact (no cross-contact opt-out),
 *   3. it is single-purpose (a signature minted for another domain, or a
 *      bare id with no signature, must not verify).
 *
 * Run: yarn test marketingUnsubToken
 */

import { createHmac } from 'node:crypto';
import { describe, test, expect } from 'vitest';
import mongoose from 'mongoose';
import { JWT_SECRET } from '@conf/env';
import {
  buildMarketingUnsubToken,
  verifyMarketingUnsubToken,
  MARKETING_UNSUB_PATH,
} from '@lib/marketingUnsubToken';

const anId = () => new mongoose.Types.ObjectId().toString();

describe('marketingUnsubToken', () => {
  test('round-trips: a freshly built token verifies back to its contact id', () => {
    const id = anId();
    const token = buildMarketingUnsubToken(id);
    expect(token.startsWith(`${id}.`)).toBe(true);
    expect(verifyMarketingUnsubToken(token)).toBe(id);
  });

  test('is per-contact: contact A cannot opt out contact B', () => {
    const a = anId();
    const b = anId();
    const tokenA = buildMarketingUnsubToken(a);
    const sigA = tokenA.slice(tokenA.indexOf('.') + 1);

    // Splice A's signature onto B's id — the classic scope-confusion attack.
    expect(verifyMarketingUnsubToken(`${b}.${sigA}`)).toBeNull();
    expect(verifyMarketingUnsubToken(tokenA)).toBe(a);
  });

  test('is single-purpose: an HMAC over the same id with a different domain does not verify', () => {
    const id = anId();
    const foreign = createHmac('sha256', JWT_SECRET).update(`some-other-purpose.${id}`).digest('base64url');
    expect(verifyMarketingUnsubToken(`${id}.${foreign}`)).toBeNull();
  });

  test('rejects tampering, missing signatures, wrong id shapes and non-strings', () => {
    const id = anId();
    const token = buildMarketingUnsubToken(id);

    expect(verifyMarketingUnsubToken(`${token}x`)).toBeNull();
    expect(verifyMarketingUnsubToken(token.slice(0, -1))).toBeNull();
    expect(verifyMarketingUnsubToken(id)).toBeNull(); // bare id, no signature
    expect(verifyMarketingUnsubToken(`not-an-object-id.${token.split('.')[1]}`)).toBeNull();
    expect(verifyMarketingUnsubToken('')).toBeNull();
    expect(verifyMarketingUnsubToken(undefined)).toBeNull();
    expect(verifyMarketingUnsubToken(null)).toBeNull();
    expect(verifyMarketingUnsubToken({ token })).toBeNull();
    // Unbounded input must not reach the HMAC.
    expect(verifyMarketingUnsubToken(`${id}.${'a'.repeat(5000)}`)).toBeNull();
  });

  test('exports the mount path so the email builder cannot invent a second copy', () => {
    expect(MARKETING_UNSUB_PATH).toBe('/api/auth/marketing/unsubscribe');
  });
});
