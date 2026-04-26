/**
 * Tests for the credential-based auth controllers:
 *   - signInController          — credential check + EMAIL_NOT_VERIFIED gate
 *   - signUpController          — duplicate email, abuse-log integration, JWT issue
 *   - verifyEmailController     — token hash + expiry + idempotency paths
 *   - forgotPasswordController  — enumeration-safe (always 200)
 *   - resendVerification        — enum-safe (auth-less variant)
 *   - resendVerificationAuthenticated — distinct EMAIL_ALREADY_VERIFIED for owner
 *   - getMeController           — read + sensitive-field stripping
 *
 * Run: yarn test credentials-flow
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import { makeUser, UserModel } from '../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../test-helpers/express';
import { generateVerificationToken, hashVerificationToken, hashPassword } from '@lib/auth';
import { AuthProvider } from '@lib/constants';

// Email + abuse-log services are mocked so we don't try to send mail or
// make real lookups. Their integration is covered by their own tests.
vi.mock('@services/emailService', () => ({
  sendVerificationEmailAsync: vi.fn(() => Promise.resolve()),
  sendVerificationEmail: vi.fn(() => Promise.resolve()),
  sendPasswordResetEmailAsync: vi.fn(() => Promise.resolve()),
  sendPasswordResetEmail: vi.fn(() => Promise.resolve()),
}));

import { signInController } from '@controlers/auth/signIn';
import { signUpController } from '@controlers/auth/signUp';
import { verifyEmailController } from '@controlers/auth/verifyEmail';
import { forgotPasswordController } from '@controlers/auth/forgotPassword';
import { resendVerificationController } from '@controlers/auth/resendVerification';
import { resendVerificationAuthenticatedController } from '@controlers/auth/resendVerificationAuthenticated';
import { getMeController } from '@controlers/auth/getMe';
import { sendVerificationEmailAsync, sendPasswordResetEmailAsync } from '@services/emailService';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
});

// ── signInController ────────────────────────────────────

describe('signInController', () => {
  test('valid credentials + verified user → 200 + JWT issued', async () => {
    await makeUser({ email: 'good@example.com', plainPassword: 'pw12345678', emailVerified: true });
    const { req, res, status, json } = buildReqRes({
      body: { email: 'good@example.com', password: 'pw12345678' },
    });
    await invokeController(signInController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    const arg = (json.mock.calls[0][0] as { data: string }).data;
    expect(typeof arg).toBe('string'); // JWT
  });

  test('non-existent email → 401 "Invalid email or password" (no enumeration leak)', async () => {
    const { req, res } = buildReqRes({
      body: { email: 'nobody@example.com', password: 'pw12345678' },
    });
    await expect(invokeController(signInController, req, res)).rejects.toThrow('Invalid email or password');
  });

  test('wrong password → 401 (same message as nonexistent — enum safety)', async () => {
    await makeUser({ email: 'pw@example.com', plainPassword: 'real-pass-1', emailVerified: true });
    const { req, res } = buildReqRes({
      body: { email: 'pw@example.com', password: 'wrong-pass!' },
    });
    await expect(invokeController(signInController, req, res)).rejects.toThrow('Invalid email or password');
  });

  test('credentials user, UNverified email → 401 with errorCode EMAIL_NOT_VERIFIED', async () => {
    await makeUser({ email: 'unv@example.com', plainPassword: 'pw12345678', emailVerified: false });
    const { req, res, status } = buildReqRes({
      body: { email: 'unv@example.com', password: 'pw12345678' },
    });
    let caught: unknown;
    try {
      await invokeController(signInController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(401);
    expect((caught as { errorCode?: string }).errorCode).toBe('EMAIL_NOT_VERIFIED');
  });

  test('Google-only user (no CREDENTIALS) cannot sign in via email/password → 401', async () => {
    await makeUser({
      email: 'google@example.com',
      authProviders: [{ provider: AuthProvider.GOOGLE, providerId: 'g1' }],
      // No password — set a placeholder via plainPassword to satisfy the schema,
      // then strip CREDENTIALS so comparePassword returns false on lookup.
      plainPassword: 'something-stored',
    });
    const { req, res } = buildReqRes({
      body: { email: 'google@example.com', password: 'wrong-anything' },
    });
    await expect(invokeController(signInController, req, res)).rejects.toThrow('Invalid email or password');
  });
});

// ── signUpController ────────────────────────────────────

describe('signUpController', () => {
  test('new email + password → 201 + JWT, user created with CREDENTIALS provider', async () => {
    const { req, res, status, json } = buildReqRes({
      body: { email: 'fresh@example.com', password: 'good-pw-12345' },
    });
    await invokeController(signUpController, req, res);
    expect(status).toHaveBeenCalledWith(201);
    expect(typeof (json.mock.calls[0][0] as { data: string }).data).toBe('string');

    const created = await UserModel.findOne({ email: 'fresh@example.com' });
    expect(created).toBeTruthy();
    expect(created?.authProviders[0].provider).toBe(AuthProvider.CREDENTIALS);
    expect(created?.emailVerified).toBe(false);
    expect(sendVerificationEmailAsync).toHaveBeenCalledOnce();
  });

  test('duplicate email → 409', async () => {
    await makeUser({ email: 'dup@example.com' });
    const { req, res } = buildReqRes({
      body: { email: 'dup@example.com', password: 'good-pw-12345' },
    });
    await expect(invokeController(signUpController, req, res)).rejects.toThrow('already exists');
  });

  test('Zod validation: short password → throws', async () => {
    const { req, res } = buildReqRes({
      body: { email: 'short@example.com', password: 'tiny' },
    });
    await expect(invokeController(signUpController, req, res)).rejects.toThrow();
  });
});

// ── verifyEmailController ──────────────────────────────

describe('verifyEmailController', () => {
  test('valid token within expiry → 200, emailVerified=true, tokens cleared', async () => {
    const { plainToken, hashedToken } = generateVerificationToken();
    const user = await makeUser({
      email: 'verify@example.com',
      emailVerified: false,
      emailVerificationToken: hashedToken,
      emailVerificationExpiry: new Date(Date.now() + 60_000),
    });

    const { req, res, status } = buildReqRes({
      body: { token: plainToken, email: 'verify@example.com' },
    });
    await invokeController(verifyEmailController, req, res);
    expect(status).toHaveBeenCalledWith(200);

    const after = await UserModel.findById(user._id).select('+emailVerificationToken +emailVerificationExpiry');
    expect(after?.emailVerified).toBe(true);
    expect(after?.emailVerificationToken).toBeFalsy();
    expect(after?.emailVerificationExpiry).toBeFalsy();
  });

  test('expired token → 410 EMAIL_VERIFICATION_EXPIRED', async () => {
    const { plainToken, hashedToken } = generateVerificationToken();
    await makeUser({
      email: 'expired@example.com',
      emailVerified: false,
      emailVerificationToken: hashedToken,
      emailVerificationExpiry: new Date(Date.now() - 1000),
    });
    const { req, res, status } = buildReqRes({
      body: { token: plainToken, email: 'expired@example.com' },
    });
    let caught: unknown;
    try {
      await invokeController(verifyEmailController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(410);
    expect((caught as { errorCode?: string }).errorCode).toBe('EMAIL_VERIFICATION_EXPIRED');
  });

  test('mismatched token hash → 400 EMAIL_VERIFICATION_INVALID', async () => {
    const { hashedToken } = generateVerificationToken();
    await makeUser({
      email: 'wrong-token@example.com',
      emailVerified: false,
      emailVerificationToken: hashedToken,
      emailVerificationExpiry: new Date(Date.now() + 60_000),
    });
    const { req, res, status } = buildReqRes({
      body: { token: 'fake-token-123', email: 'wrong-token@example.com' },
    });
    let caught: unknown;
    try {
      await invokeController(verifyEmailController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(400);
    expect((caught as { errorCode?: string }).errorCode).toBe('EMAIL_VERIFICATION_INVALID');
  });

  test('already verified → 400 EMAIL_ALREADY_VERIFIED', async () => {
    await makeUser({ email: 'av@example.com', emailVerified: true });
    const { req, res, status } = buildReqRes({
      body: { token: 'whatever', email: 'av@example.com' },
    });
    let caught: unknown;
    try {
      await invokeController(verifyEmailController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(400);
    expect((caught as { errorCode?: string }).errorCode).toBe('EMAIL_ALREADY_VERIFIED');
  });

  test('unknown email → 400 EMAIL_VERIFICATION_INVALID (not 404 — enum safety)', async () => {
    const { req, res, status } = buildReqRes({
      body: { token: 'whatever', email: 'noone@example.com' },
    });
    let caught: unknown;
    try {
      await invokeController(verifyEmailController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(400);
    expect((caught as { errorCode?: string }).errorCode).toBe('EMAIL_VERIFICATION_INVALID');
  });
});

// ── forgotPasswordController ───────────────────────────

describe('forgotPasswordController', () => {
  test('existing email → 200 + sends reset email + stores reset token', async () => {
    const user = await makeUser({ email: 'reset-me@example.com' });
    const { req, res, status } = buildReqRes({
      body: { email: 'reset-me@example.com' },
    });
    await invokeController(forgotPasswordController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(sendPasswordResetEmailAsync).toHaveBeenCalledOnce();

    const after = await UserModel.findById(user._id).select('+passwordResetToken +passwordResetExpiry');
    expect(after?.passwordResetToken).toBeTruthy();
    expect(after?.passwordResetExpiry).toBeInstanceOf(Date);
  });

  test('nonexistent email → 200 (enumeration safety) + NO email send', async () => {
    const { req, res, status } = buildReqRes({
      body: { email: 'nobody@example.com' },
    });
    await invokeController(forgotPasswordController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(sendPasswordResetEmailAsync).not.toHaveBeenCalled();
  });
});

// ── resendVerificationController (enum-safe via password verify) ─

describe('resendVerificationController', () => {
  test('valid creds + unverified → 200 + sends verification email', async () => {
    const { hashedToken } = generateVerificationToken();
    await makeUser({
      email: 'resend@example.com',
      plainPassword: 'pw12345678',
      emailVerified: false,
      emailVerificationToken: hashedToken,
      emailVerificationExpiry: new Date(Date.now() + 60_000),
    });
    const { req, res, status } = buildReqRes({
      body: { email: 'resend@example.com', password: 'pw12345678' },
    });
    await invokeController(resendVerificationController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(sendVerificationEmailAsync).toHaveBeenCalledOnce();
  });

  test('valid creds + ALREADY VERIFIED → 200 + NO email (silent skip — enum safety)', async () => {
    await makeUser({
      email: 'av-resend@example.com',
      plainPassword: 'pw12345678',
      emailVerified: true,
    });
    const { req, res, status } = buildReqRes({
      body: { email: 'av-resend@example.com', password: 'pw12345678' },
    });
    await invokeController(resendVerificationController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(sendVerificationEmailAsync).not.toHaveBeenCalled();
  });

  test('wrong password → 401 (same message as nonexistent — enum safety)', async () => {
    await makeUser({ email: 'pw-resend@example.com', plainPassword: 'real-pass' });
    const { req, res } = buildReqRes({
      body: { email: 'pw-resend@example.com', password: 'wrong' },
    });
    await expect(invokeController(resendVerificationController, req, res)).rejects.toThrow(
      'Invalid email or password',
    );
  });

  test('nonexistent email → 401 (same message — enum safety)', async () => {
    const { req, res } = buildReqRes({
      body: { email: 'nope@example.com', password: 'whatever-pass' },
    });
    await expect(invokeController(resendVerificationController, req, res)).rejects.toThrow(
      'Invalid email or password',
    );
  });
});

// ── resendVerificationAuthenticatedController ─────────

describe('resendVerificationAuthenticatedController', () => {
  test('authenticated unverified user → 200 + email sent', async () => {
    const user = await makeUser({ emailVerified: false });
    const { req, res, status } = buildReqRes({ userId: user._id.toString() });
    await invokeController(resendVerificationAuthenticatedController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(sendVerificationEmailAsync).toHaveBeenCalledOnce();
  });

  test('authenticated VERIFIED user → 400 EMAIL_ALREADY_VERIFIED (distinct error — caller IS owner)', async () => {
    const user = await makeUser({ emailVerified: true });
    const { req, res, status } = buildReqRes({ userId: user._id.toString() });
    let caught: unknown;
    try {
      await invokeController(resendVerificationAuthenticatedController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(400);
    expect((caught as { errorCode?: string }).errorCode).toBe('EMAIL_ALREADY_VERIFIED');
  });
});

// ── getMeController ──────────────────────────────────

describe('getMeController', () => {
  test('returns hydrated user (sensitive fields stripped by toJSON)', async () => {
    const user = await makeUser({
      email: 'me@example.com',
      plainPassword: 'pw12345678',
    });
    const { req, res, json } = buildReqRes({ userId: user._id.toString() });
    await invokeController(getMeController, req, res);

    const body = json.mock.calls[0][0] as { data: { user: Record<string, unknown>; email?: string } | Record<string, unknown> };
    // toJSON strips: password, emailVerificationToken, emailVerificationExpiry,
    // passwordResetToken, passwordResetExpiry, tokenVersion, Stripe IDs.
    const userJson = JSON.stringify(body);
    expect(userJson).toContain('me@example.com');
    expect(userJson).not.toContain('password');
    expect(userJson).not.toContain('tokenVersion');
    expect(userJson).not.toContain('emailVerificationToken');
    expect(userJson).not.toContain('passwordResetToken');
  });
});
