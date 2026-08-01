/**
 * Tests for the auth gates: `protect`, `requireVerified` and `requireAdmin`.
 * These are the single entry points for token-based session management; bugs
 * here surface as session-hijack or unauthorized data access.
 *
 * `requireAdmin` had ZERO references in any test file in this repo until
 * PLAN Phase 5, while being the last gate in front of
 * `POST /api/admin/marketing/send` — which mass-mails the entire contact
 * ledger. The two bugs this block exists to prevent:
 *   1. the role check inverted or dropped, so a verified non-admin sends the
 *      campaign (irreversible, with consent/GDPR consequences); and
 *   2. the refusal returned as 401 instead of 403, which trips the client's
 *      axios auto-sign-out interceptor and evicts a legitimately signed-in
 *      user for touching an admin URL. That is why the negative assertion
 *      `not.toHaveBeenCalledWith(401)` is here and not just the positive one.
 *
 * Strategy:
 *   - Real in-memory Mongo so tokenVersion + emailVerified live on real User
 *     rows (avoids stubbing out the very behavior we want to test)
 *   - decodeAuthToken is the real one, generating + verifying with the
 *     test-setup JWT_SECRET
 *   - express Request/Response/NextFunction are minimal mocks
 *
 * Run: yarn test authMiddleware
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi } from 'vitest';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, UserModel } from '../../test-helpers/factories';
import { generateAuthToken, decodeAuthToken } from '@lib/auth';
import { protect, requireAdmin, requireVerified } from '@middleware/authMiddleware';
import { JWT_SECRET } from '@conf/env';
import { AuthProvider } from '@lib/constants';

setupTestDb();

const buildReqRes = (params: { authHeader?: string; userId?: string } = {}) => {
  const req = {
    headers: params.authHeader ? { authorization: params.authHeader } : {},
    userId: params.userId,
  } as unknown as Request;
  const res = {
    status: vi.fn(function (this: Response, _code: number) {
      return this;
    }),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
};

const runMiddleware = (
  handler: RequestHandler,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const wrappedNext = ((err?: unknown) => {
      if (err) reject(err);
      else {
        (next as () => void)();
        resolve();
      }
    }) as NextFunction;
    Promise.resolve(handler(req, res, wrappedNext)).catch(reject);
  });
};

// ── decodeAuthToken — JWT verification edge cases ───────

describe('decodeAuthToken', () => {
  test('valid HS256 token round-trips', () => {
    const token = generateAuthToken({ id: 'user-1', tokenVersion: 0 });
    const decoded = decodeAuthToken(token);
    expect(decoded?.id).toBe('user-1');
    expect(decoded?.tokenVersion).toBe(0);
  });

  test('garbage token → undefined (caught, not thrown)', () => {
    expect(decodeAuthToken('not-a-jwt')).toBeUndefined();
  });

  test('empty string → undefined', () => {
    expect(decodeAuthToken('')).toBeUndefined();
  });

  test('token signed with a DIFFERENT secret → undefined', () => {
    const fake = jwt.sign({ id: 'attacker', tokenVersion: 0 }, 'wrong-secret', {
      algorithm: 'HS256',
      expiresIn: '30d',
    });
    expect(decodeAuthToken(fake)).toBeUndefined();
  });

  test('expired token → undefined', () => {
    const expired = jwt.sign({ id: 'user-x', tokenVersion: 0 }, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: -10, // already expired
    });
    expect(decodeAuthToken(expired)).toBeUndefined();
  });

  test('alg=none token is rejected (downgrade attack defense)', () => {
    // Hand-craft an alg=none JWT: header.payload. (no signature)
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ id: 'attacker', tokenVersion: 0, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }),
    ).toString('base64url');
    const noneToken = `${header}.${payload}.`;
    expect(decodeAuthToken(noneToken)).toBeUndefined();
  });

  test('token with RS256 alg (key-confusion attempt) → undefined under HS256-only allowlist', () => {
    // jwt.sign with `algorithm: 'HS256'` is what we use; if someone managed
    // to mint a token claiming alg=RS256, our verify call (algorithms:
    // ['HS256']) would refuse. This test forges that header with the SAME
    // secret as the symmetric "key" — under a buggy verifier this would
    // pass as RS256-with-shared-key. Our allowlist must reject it.
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ id: 'attacker', tokenVersion: 0 }),
    ).toString('base64url');
    // Sign with HS256 over header+payload using the shared secret. The output
    // would deceive a verifier that respects the alg field.
    const crypto = require('node:crypto');
    const sig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    const forged = `${header}.${payload}.${sig}`;
    expect(decodeAuthToken(forged)).toBeUndefined();
  });
});

// ── protect middleware ─────────────────────────────────

describe('protect', () => {
  test('happy path: valid token + matching tokenVersion → next() with req.userId set', async () => {
    const user = await makeUser();
    const token = generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion });
    const { req, res, next } = buildReqRes({ authHeader: `Bearer ${token}` });
    await runMiddleware(protect, req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request).userId).toBe(user._id.toString());
  });

  test('missing Authorization header → 401', async () => {
    const { req, res, next } = buildReqRes();
    await expect(runMiddleware(protect, req, res, next)).rejects.toThrow('Unauthorized');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('Authorization header without Bearer prefix → 401', async () => {
    const { req, res, next } = buildReqRes({ authHeader: 'Basic abc' });
    await expect(runMiddleware(protect, req, res, next)).rejects.toThrow('Unauthorized');
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('garbage token → 401', async () => {
    const { req, res, next } = buildReqRes({ authHeader: 'Bearer not-a-jwt' });
    await expect(runMiddleware(protect, req, res, next)).rejects.toThrow('Unauthorized');
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('expired token → 401', async () => {
    const user = await makeUser();
    const expired = jwt.sign(
      { id: user._id.toString(), tokenVersion: user.tokenVersion },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: -10 },
    );
    const { req, res, next } = buildReqRes({ authHeader: `Bearer ${expired}` });
    await expect(runMiddleware(protect, req, res, next)).rejects.toThrow('Unauthorized');
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('token with stale tokenVersion (post-logout) → 401', async () => {
    const user = await makeUser();
    // Mint at version 0, then bump on the user row to simulate logout.
    const token = generateAuthToken({ id: user._id.toString(), tokenVersion: 0 });
    await UserModel.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });

    const { req, res, next } = buildReqRes({ authHeader: `Bearer ${token}` });
    await expect(runMiddleware(protect, req, res, next)).rejects.toThrow('Unauthorized');
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('token references a user that has been deleted → 401', async () => {
    const user = await makeUser();
    const token = generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion });
    await UserModel.deleteOne({ _id: user._id });

    const { req, res, next } = buildReqRes({ authHeader: `Bearer ${token}` });
    await expect(runMiddleware(protect, req, res, next)).rejects.toThrow('Unauthorized');
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ── requireVerified middleware ─────────────────────────

describe('requireVerified', () => {
  test('CREDENTIALS user, verified → next()', async () => {
    const user = await makeUser({ emailVerified: true });
    const { req, res, next } = buildReqRes({ userId: user._id.toString() });
    await runMiddleware(requireVerified, req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('CREDENTIALS user, UNverified → 403 EMAIL_NOT_VERIFIED (not 401)', async () => {
    const user = await makeUser({ emailVerified: false });
    const { req, res, next } = buildReqRes({ userId: user._id.toString() });

    let caughtErr: unknown;
    try {
      await runMiddleware(requireVerified, req, res, next);
    } catch (e) {
      caughtErr = e;
    }
    expect(res.status).toHaveBeenCalledWith(403);
    // 403 not 401 is critical — the client's axios interceptor signs the
    // user out on 401 only.
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect((caughtErr as { errorCode?: string }).errorCode).toBe('EMAIL_NOT_VERIFIED');
  });

  test('Google-only user (no CREDENTIALS provider): UNverified → still passes', async () => {
    // Per CLAUDE.md / authMiddleware comments: only credential users are gated.
    // A Google-only sign-in implicitly has emailVerified by virtue of OAuth.
    const user = await makeUser({
      emailVerified: false,
      authProviders: [{ provider: AuthProvider.GOOGLE, providerId: 'google-uid-1' }],
    });
    const { req, res, next } = buildReqRes({ userId: user._id.toString() });
    await runMiddleware(requireVerified, req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('mixed providers (CREDENTIALS unverified + GOOGLE): 403 fires', async () => {
    const user = await makeUser({
      emailVerified: false,
      authProviders: [
        { provider: AuthProvider.CREDENTIALS },
        { provider: AuthProvider.GOOGLE, providerId: 'google-uid-2' },
      ],
    });
    const { req, res, next } = buildReqRes({ userId: user._id.toString() });
    await expect(runMiddleware(requireVerified, req, res, next)).rejects.toMatchObject({
      errorCode: 'EMAIL_NOT_VERIFIED',
    });
  });

  test('user deleted between protect and requireVerified → 401', async () => {
    const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // 24-hex but no row
    const { req, res, next } = buildReqRes({ userId });
    await expect(runMiddleware(requireVerified, req, res, next)).rejects.toThrow('Unauthorized');
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ── requireAdmin middleware ────────────────────────────
//
// Gate order is `protect → requireVerified → requireAdmin`, so by the time
// this runs `req.userId` is set and the row exists in the common case. The
// only legitimate 401 is a row that vanished between gates.

describe('requireAdmin', () => {
  test('isAdmin: true → next() with no error', async () => {
    const user = await makeUser({ isAdmin: true });
    const { req, res, next } = buildReqRes({ userId: user._id.toString() });
    await runMiddleware(requireAdmin, req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('a verified NON-ADMIN is refused with 403 — and is NOT signed out (401)', async () => {
    const user = await makeUser({ isAdmin: false, emailVerified: true });
    const { req, res, next } = buildReqRes({ userId: user._id.toString() });

    let caughtErr: unknown;
    try {
      await runMiddleware(requireAdmin, req, res, next);
    } catch (e) {
      caughtErr = e;
    }
    expect(res.status).toHaveBeenCalledWith(403);
    // 403 not 401 is the whole point: the client's axios interceptor signs
    // the user out on 401 only. A non-admin poking an admin URL must stay
    // signed in.
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect((caughtErr as Error).message).toMatch(/admin access required/i);
    expect((caughtErr as { errorCode?: string }).errorCode).toBe('CUSTOM_ERROR');
  });

  test('user row missing (deleted between gates) → 401, the one legitimate 401', async () => {
    const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // 24-hex, no row
    const { req, res, next } = buildReqRes({ userId });
    await expect(runMiddleware(requireAdmin, req, res, next)).rejects.toThrow('Unauthorized');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('isAdmin defaults to false on a freshly created user (factory must not hand out admins)', async () => {
    // Guards the arrange step of every test above: if `makeUser` ever
    // defaulted `isAdmin` to true, the 403 cases would silently become
    // no-ops that pass for the wrong reason.
    const user = await makeUser();
    const row = await UserModel.findById(user._id).select('isAdmin').lean();
    expect(row?.isAdmin).toBe(false);
  });

  test('an UNVERIFIED admin still passes requireAdmin — verification is requireVerified\'s job, not this gate\'s', async () => {
    // Pins the separation of concerns in the `protect → requireVerified →
    // requireAdmin` chain. If requireAdmin grew its own verification check,
    // the 403 reason surfaced to the client would become ambiguous.
    const user = await makeUser({ isAdmin: true, emailVerified: false });
    const { req, res, next } = buildReqRes({ userId: user._id.toString() });
    await runMiddleware(requireAdmin, req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ── optionalProtect — soft-auth helper ───────────────────
//
// Used by the public productKb chat surface (anonymous visitors allowed,
// signed-in users get attribution). The contract is "never reject; attach
// req.userId only when the bearer token is fully valid". Audit gap: this
// path was previously untested even though it gates a paid LLM endpoint.

import { optionalProtect } from '@middleware/authMiddleware';

describe('optionalProtect', () => {
  test('no Authorization header → next() with userId unset', async () => {
    const { req, res, next } = buildReqRes();
    await runMiddleware(optionalProtect, req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBeUndefined();
  });

  test('non-Bearer scheme (Basic …) → next() with userId unset', async () => {
    const { req, res, next } = buildReqRes({ authHeader: 'Basic dXNlcjpwYXNz' });
    await runMiddleware(optionalProtect, req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBeUndefined();
  });

  test('Bearer with empty token → next() with userId unset', async () => {
    const { req, res, next } = buildReqRes({ authHeader: 'Bearer ' });
    await runMiddleware(optionalProtect, req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBeUndefined();
  });

  test('Bearer with garbage token → next() with userId unset (silent fall-through)', async () => {
    const { req, res, next } = buildReqRes({ authHeader: 'Bearer not-a-jwt' });
    await runMiddleware(optionalProtect, req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBeUndefined();
  });

  test('valid Bearer token → next() with req.userId set', async () => {
    const user = await makeUser({});
    const token = generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion });
    const { req, res, next } = buildReqRes({ authHeader: `Bearer ${token}` });
    await runMiddleware(optionalProtect, req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBe(user._id.toString());
  });

  test('valid token but stale tokenVersion (post-logout) → next() with userId unset', async () => {
    const user = await makeUser({ tokenVersion: 0 });
    // Token issued at v0; user's version bumped to 1 (e.g. via logout).
    const stale = generateAuthToken({ id: user._id.toString(), tokenVersion: 0 });
    await UserModel.updateOne({ _id: user._id }, { tokenVersion: 1 });
    const { req, res, next } = buildReqRes({ authHeader: `Bearer ${stale}` });
    await runMiddleware(optionalProtect, req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBeUndefined();
  });

  test('valid-shape token referencing a deleted user → next() with userId unset', async () => {
    // 24-hex ObjectId that has no matching row.
    const token = generateAuthToken({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', tokenVersion: 0 });
    const { req, res, next } = buildReqRes({ authHeader: `Bearer ${token}` });
    await runMiddleware(optionalProtect, req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userId).toBeUndefined();
  });

  test('DB throw during user lookup → next() with userId unset (never 5xx)', async () => {
    const token = generateAuthToken({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', tokenVersion: 0 });
    const { req, res, next } = buildReqRes({ authHeader: `Bearer ${token}` });
    // Force the lookup to throw — public surfaces should never propagate this.
    const findByIdSpy = vi
      .spyOn(UserModel, 'findById')
      .mockReturnValueOnce({
        select: () => ({ lean: () => Promise.reject(new Error('mongo down')) }),
      } as never);
    try {
      await runMiddleware(optionalProtect, req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(req.userId).toBeUndefined();
    } finally {
      findByIdSpy.mockRestore();
    }
  });

  // assert is imported above; this tag-along call exists so the import isn't
  // marked unused by linters when this block is the only consumer.
  assert.equal(typeof optionalProtect, 'function');
});
