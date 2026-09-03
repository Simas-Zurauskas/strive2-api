/**
 * Tests for googleAuthController. The MOST security-critical auth path:
 * the account-linking HIJACK GUARD branch must strip the password and bump
 * tokenVersion when an unverified credentials user gets a Google sign-in
 * for the same email. CLAUDE.md flags this explicitly.
 *
 * Strategy:
 *   - Mock OAuth2Client.verifyIdToken so we control the payload
 *   - Mock abuseLogService.resolveSignupAllowance (its own tests cover it)
 *
 * Run: yarn test googleAuth
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import { makeUser, UserModel } from '../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../test-helpers/express';
import { AuthProvider } from '@lib/constants';
import { PLANS } from '@lib/creditPricing';

// Hoisted stub for the Google OAuth client. The controller imports
// google-auth-library at module init time; vi.mock replaces it so we can
// drive verifyIdToken with canned payloads.
const { fakeVerifyIdToken } = vi.hoisted(() => ({
  fakeVerifyIdToken: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = fakeVerifyIdToken;
  },
}));

// Abuse log: by default return normal Free-plan grant. Tests that need a
// blocked-signup scenario override per-test.
const { fakeResolveSignupAllowance } = vi.hoisted(() => ({
  fakeResolveSignupAllowance: vi.fn(),
}));
vi.mock('@services/abuseLogService', () => ({
  resolveSignupAllowance: fakeResolveSignupAllowance,
  recordAccountDeletion: vi.fn(),
}));

import { googleAuthController } from '@controlers/auth/googleAuth';
import { onboardingAllowanceCredits } from '@lib/pricingConfig';
import MarketingContactModel from '@models/MarketingContactModel';

setupTestDb();

beforeEach(() => {
  fakeVerifyIdToken.mockReset();
  fakeResolveSignupAllowance.mockReset();
  // Mirrors what the REAL resolver returns for a clean email since
  // 2026-09-02 (pricingConfig KNOB 9). Previously this stub returned the
  // 200cr monthly allowance, so the whole suite passed green while proving
  // nothing about whether the Google path carries the onboarding grant —
  // half of AC2 was unverified. abuseLogService.test.ts pins that the
  // resolver returns this value; these tests pin that Google's plumbing
  // delivers whatever it returns, unaltered.
  fakeResolveSignupAllowance.mockResolvedValue({
    allowanceBalance: onboardingAllowanceCredits(),
    allowanceGranted: onboardingAllowanceCredits(),
    blocked: false,
  });
});

const mockGoogleTicket = (payload: { email?: string; email_verified?: boolean; sub?: string; name?: string; picture?: string } | null) => {
  fakeVerifyIdToken.mockResolvedValueOnce({
    getPayload: () => payload,
  });
};

// ── Token validation ──────────────────────────────────

describe('googleAuthController — token validation', () => {
  test('payload missing email → 400', async () => {
    mockGoogleTicket({ email_verified: true });
    const { req, res, status } = buildReqRes({ body: { idToken: 'fake-token' } });
    await expect(invokeController(googleAuthController, req, res)).rejects.toThrow('Unable to verify');
    expect(status).toHaveBeenCalledWith(400);
  });

  test('payload with email_verified=false → 400 "email is not verified"', async () => {
    mockGoogleTicket({ email: 'bad@example.com', email_verified: false, sub: 'g1' });
    const { req, res, status } = buildReqRes({ body: { idToken: 'fake-token' } });
    await expect(invokeController(googleAuthController, req, res)).rejects.toThrow('email is not verified');
    expect(status).toHaveBeenCalledWith(400);
  });

  test('verifyIdToken throws (invalid token) → propagates as 500-equivalent error', async () => {
    fakeVerifyIdToken.mockRejectedValueOnce(new Error('Invalid token signature'));
    const { req, res } = buildReqRes({ body: { idToken: 'forged' } });
    await expect(invokeController(googleAuthController, req, res)).rejects.toThrow('Invalid token signature');
  });
});

// ── New user path ─────────────────────────────────────

describe('googleAuthController — new user', () => {
  test('brand-new email: creates user with emailVerified=true, GOOGLE provider, free allowance', async () => {
    mockGoogleTicket({
      email: 'newgoogle@example.com',
      email_verified: true,
      sub: 'g-uid-1',
      name: 'New User',
      picture: 'https://lh3.googleusercontent.com/x',
    });

    const { req, res, status, json } = buildReqRes({ body: { idToken: 'fresh-token' } });
    await invokeController(googleAuthController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(typeof (json.mock.calls[0][0] as { data: string }).data).toBe('string'); // JWT

    const user = await UserModel.findOne({ email: 'newgoogle@example.com' });
    expect(user?.emailVerified).toBe(true);
    expect(user?.name).toBe('New User');
    expect(user?.image).toBe('https://lh3.googleusercontent.com/x');
    const googleEntries = user?.authProviders.filter((p) => p.provider === AuthProvider.GOOGLE);
    expect(googleEntries).toHaveLength(1);
    expect(googleEntries?.[0].providerId).toBe('g-uid-1');
    // AC2, Google half: the grant reaches the created account intact, and is
    // strictly larger than the recurring allowance it decays to.
    expect(user?.credits.allowanceBalance).toBe(onboardingAllowanceCredits());
    expect(user?.credits.allowanceGranted).toBe(onboardingAllowanceCredits());
    expect(user?.credits.allowanceBalance).toBeGreaterThan(PLANS.free.monthlyAllowance);
  });

  test('new Google user is enrolled in MarketingContact — AC4, the Google half', async () => {
    // The gap this closes: Google sets emailVerified directly and never
    // reaches verifyEmail.ts, which was the only enrolment site. Every Google
    // signup was therefore created outside the promotional audience — 20 of
    // the 26 most recent signups when this was written.
    mockGoogleTicket({
      email: 'enrolme@example.com',
      email_verified: true,
      sub: 'g-enrol-1',
      name: 'Enrol Me',
    });

    const { req, res } = buildReqRes({ body: { idToken: 'fresh-token' } });
    await invokeController(googleAuthController, req, res);

    const contact = await MarketingContactModel.findOne({ email: 'enrolme@example.com' }).lean();
    expect(contact).not.toBeNull();
    expect(contact?.optedOut).toBe(false);
    expect(contact?.source).toBe('signup');
    const user = await UserModel.findOne({ email: 'enrolme@example.com' });
    expect(String(contact?.userId)).toBe(String(user?._id));
  });

  test('an EXISTING unverified credentials user is enrolled when Google completes them', async () => {
    // The gap a `!existing` gate leaves. Someone signs up with credentials and
    // never verifies; the real owner then completes the same address via
    // Google. `existing` is truthy, so a row-creation-gated enrolment skips
    // them — yet this is that person's first ever verification, which is
    // exactly the event the credentials path (verifyEmail.ts) enrols on.
    // Unlike the historical `marketing:seed` backfill, that leak would keep
    // widening. Enrolment is therefore gated on successful auth, not on
    // whether the User row happened to pre-exist.
    await UserModel.create({
      email: 'hijack-rescue@example.com',
      password: 'irrelevant-hash',
      emailVerified: false,
      authProviders: [{ provider: AuthProvider.CREDENTIALS, providerId: 'hijack-rescue@example.com' }],
    });
    expect(await MarketingContactModel.countDocuments({ email: 'hijack-rescue@example.com' })).toBe(0);

    mockGoogleTicket({
      email: 'hijack-rescue@example.com',
      email_verified: true,
      sub: 'g-hijack-rescue',
    });
    const { req, res } = buildReqRes({ body: { idToken: 't' } });
    await invokeController(googleAuthController, req, res);

    const contact = await MarketingContactModel.findOne({ email: 'hijack-rescue@example.com' }).lean();
    expect(contact).not.toBeNull();
    expect(contact?.optedOut).toBe(false);
  });

  test('a RETURNING Google user does not get a second contact row', async () => {
    // Sign in twice. Enrolment is NOT gated on `!existing` (that gate was the
    // bug — see the hijack-rescue case above), so this runs on both sign-ins
    // and idempotency rests entirely on the upsert being `$setOnInsert` with a
    // unique index on `email`. That single layer is what keeps it at one row.
    for (const sub of ['g-repeat', 'g-repeat']) {
      mockGoogleTicket({ email: 'repeat@example.com', email_verified: true, sub });
      const { req, res } = buildReqRes({ body: { idToken: 't' } });
      await invokeController(googleAuthController, req, res);
    }
    expect(await MarketingContactModel.countDocuments({ email: 'repeat@example.com' })).toBe(1);
  });

  test('new user with abuse-log block: created with zero allowance', async () => {
    fakeResolveSignupAllowance.mockResolvedValueOnce({
      allowanceBalance: 0,
      allowanceGranted: 0,
      blocked: true,
    });
    mockGoogleTicket({
      email: 'recycled@example.com',
      email_verified: true,
      sub: 'g-recycled',
    });

    const { req, res } = buildReqRes({ body: { idToken: 't' } });
    await invokeController(googleAuthController, req, res);

    const user = await UserModel.findOne({ email: 'recycled@example.com' });
    expect(user?.credits.allowanceBalance).toBe(0);
    expect(user?.credits.allowanceGranted).toBe(0);
  });
});

// ── Existing user merge (no hijack scenario) ──────────

describe('googleAuthController — existing user merge', () => {
  test('verified Google-linked user signs in again: GOOGLE entry deduped (no duplicates accumulate)', async () => {
    const existing = await makeUser({
      email: 'merged@example.com',
      emailVerified: true,
      authProviders: [{ provider: AuthProvider.GOOGLE, providerId: 'g-old' }],
    });

    mockGoogleTicket({
      email: 'merged@example.com',
      email_verified: true,
      sub: 'g-old', // same Google id
    });
    const { req, res } = buildReqRes({ body: { idToken: 't' } });
    await invokeController(googleAuthController, req, res);

    const after = await UserModel.findById(existing._id);
    const googleEntries = after?.authProviders.filter((p) => p.provider === AuthProvider.GOOGLE);
    expect(googleEntries).toHaveLength(1); // deduped, not 2
  });

  test('existing user with VERIFIED credentials: Google merge does NOT strip the password', async () => {
    const user = await makeUser({
      email: 'mixed@example.com',
      emailVerified: true,
      authProviders: [{ provider: AuthProvider.CREDENTIALS }],
    });
    const before = await UserModel.findById(user._id).select('+password tokenVersion').lean();

    mockGoogleTicket({
      email: 'mixed@example.com',
      email_verified: true,
      sub: 'g-mix',
    });
    const { req, res } = buildReqRes({ body: { idToken: 't' } });
    await invokeController(googleAuthController, req, res);

    const after = await UserModel.findById(user._id).select('+password tokenVersion authProviders');
    expect(after?.password).toBe(before?.password); // unchanged
    expect(after?.tokenVersion).toBe(before?.tokenVersion); // unchanged

    // Both providers present
    const providerKinds = after?.authProviders.map((p) => p.provider).sort();
    expect(providerKinds).toContain(AuthProvider.CREDENTIALS);
    expect(providerKinds).toContain(AuthProvider.GOOGLE);
  });
});

// ── HIJACK GUARD (the security-critical branch) ───────

describe('googleAuthController — HIJACK GUARD', () => {
  test('UNVERIFIED credentials user signs in via Google: password STRIPPED, CREDENTIALS REMOVED, tokenVersion BUMPED', async () => {
    // Simulates: attacker signed up with victim@x.com via credentials,
    // never verified. Victim now signs in via Google for the same address.
    const victim = await makeUser({
      email: 'victim@example.com',
      emailVerified: false, // attacker's account was unverified
      authProviders: [{ provider: AuthProvider.CREDENTIALS }],
    });
    const before = await UserModel.findById(victim._id).select('+password tokenVersion').lean();
    expect(before?.password).toBeTruthy();

    mockGoogleTicket({
      email: 'victim@example.com',
      email_verified: true,
      sub: 'g-victim',
      name: 'Real Victim',
    });
    const { req, res, status } = buildReqRes({ body: { idToken: 't' } });
    await invokeController(googleAuthController, req, res);
    expect(status).toHaveBeenCalledWith(200);

    const after = await UserModel.findById(victim._id).select('+password tokenVersion authProviders emailVerified');
    // 1. Attacker's password is GONE
    expect(after?.password).toBeFalsy();
    // 2. CREDENTIALS provider is GONE — only GOOGLE remains
    const providers = after?.authProviders.map((p) => p.provider) ?? [];
    expect(providers).not.toContain(AuthProvider.CREDENTIALS);
    expect(providers).toContain(AuthProvider.GOOGLE);
    // 3. tokenVersion bumped — any pre-verification JWT the attacker holds is invalidated
    expect(after?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);
    // 4. Email is now verified (Google's flow proves it)
    expect(after?.emailVerified).toBe(true);
  });

  test('hijack guard does NOT fire when the credentials user is already verified', async () => {
    const user = await makeUser({
      email: 'safe@example.com',
      emailVerified: true, // already proved ownership
      authProviders: [{ provider: AuthProvider.CREDENTIALS }],
    });
    const before = await UserModel.findById(user._id).select('+password tokenVersion').lean();

    mockGoogleTicket({
      email: 'safe@example.com',
      email_verified: true,
      sub: 'g-safe',
    });
    const { req, res } = buildReqRes({ body: { idToken: 't' } });
    await invokeController(googleAuthController, req, res);

    const after = await UserModel.findById(user._id).select('+password tokenVersion authProviders');
    expect(after?.password).toBe(before?.password); // password preserved
    expect(after?.tokenVersion).toBe(before?.tokenVersion); // tokenVersion preserved
  });
});
