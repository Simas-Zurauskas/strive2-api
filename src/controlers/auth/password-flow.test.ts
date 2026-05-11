/**
 * Tests for the password-mutation controllers:
 *   - resetPasswordController   — token + tokenVersion bump + authProviders rebuild
 *   - setPasswordController     — Google-only-account guard, PASSWORD_ALREADY_SET
 *   - changePasswordController  — tokenVersion bump, PASSWORD_NOT_SET guard
 *
 * All three bump tokenVersion on success so any existing JWT becomes invalid.
 *
 * Run: yarn test password-flow
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import { makeUser, UserModel } from '../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../test-helpers/express';
import { generateVerificationToken } from '@lib/auth';
import { AuthProvider } from '@lib/constants';
import { AppError } from '@middleware/errorMiddleware';

// Stub the email-OTP service so changePassword tests stay focused on the
// post-confirmation logic. The OTP flow itself is exercised by the
// securityActionService unit tests (TODO if not present) and end-to-end
// by the auth-route tests. Per-test we override the mock impl when we
// want to assert the OTP rejection path.
const consumeMock = vi.fn();
vi.mock('@services/securityActionService', () => ({
  consumeSecurityActionCode: (...args: unknown[]) => consumeMock(...args),
}));

import { resetPasswordController } from '@controlers/auth/resetPassword';
import { setPasswordController } from '@controlers/auth/setPassword';
import { changePasswordController } from '@controlers/auth/changePassword';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
});

// ── resetPasswordController ────────────────────────────

describe('resetPasswordController', () => {
  test('valid token within expiry: password updated, tokenVersion bumped, CREDENTIALS provider re-added', async () => {
    const { plainToken, hashedToken } = generateVerificationToken();
    const user = await makeUser({
      email: 'r@example.com',
      passwordResetToken: hashedToken,
      passwordResetExpiry: new Date(Date.now() + 60_000),
      authProviders: [{ provider: AuthProvider.GOOGLE, providerId: 'g1' }], // no CREDENTIALS yet
    });
    const before = await UserModel.findById(user._id).lean();

    const { req, res, status } = buildReqRes({
      body: { email: 'r@example.com', token: plainToken, newPassword: 'new-pw-12345' },
    });
    await invokeController(resetPasswordController, req, res);
    expect(status).toHaveBeenCalledWith(200);

    const after = await UserModel.findById(user._id).select('+password +passwordResetToken authProviders tokenVersion');
    expect(after?.password).toBeTruthy();
    expect(after?.password).not.toBe(before?.password); // hash changed
    expect(after?.passwordResetToken).toBeFalsy();
    expect(after?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);
    // authProviders should now include CREDENTIALS exactly once + the original GOOGLE
    const providers = after?.authProviders.map((p) => p.provider) ?? [];
    expect(providers).toContain(AuthProvider.CREDENTIALS);
    expect(providers).toContain(AuthProvider.GOOGLE);
    expect(providers.filter((p) => p === AuthProvider.CREDENTIALS)).toHaveLength(1);
  });

  test('expired reset token → 410 PASSWORD_RESET_EXPIRED', async () => {
    const { plainToken, hashedToken } = generateVerificationToken();
    await makeUser({
      email: 'rexp@example.com',
      passwordResetToken: hashedToken,
      passwordResetExpiry: new Date(Date.now() - 1000),
    });
    const { req, res, status } = buildReqRes({
      body: { email: 'rexp@example.com', token: plainToken, newPassword: 'new-pw-12345' },
    });
    let caught: unknown;
    try {
      await invokeController(resetPasswordController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(410);
    expect((caught as { errorCode?: string }).errorCode).toBe('PASSWORD_RESET_EXPIRED');
  });

  test('mismatched token → 400 PASSWORD_RESET_INVALID', async () => {
    const { hashedToken } = generateVerificationToken();
    await makeUser({
      email: 'rmis@example.com',
      passwordResetToken: hashedToken,
      passwordResetExpiry: new Date(Date.now() + 60_000),
    });
    const { req, res, status } = buildReqRes({
      body: { email: 'rmis@example.com', token: 'wrong-token', newPassword: 'new-pw-12345' },
    });
    let caught: unknown;
    try {
      await invokeController(resetPasswordController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(400);
    expect((caught as { errorCode?: string }).errorCode).toBe('PASSWORD_RESET_INVALID');
  });

  test('user without a reset token → 400 PASSWORD_RESET_INVALID (not 404 — enum safety)', async () => {
    await makeUser({ email: 'rno@example.com' });
    const { req, res, status } = buildReqRes({
      body: { email: 'rno@example.com', token: 'whatever', newPassword: 'new-pw-12345' },
    });
    let caught: unknown;
    try {
      await invokeController(resetPasswordController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(400);
    expect((caught as { errorCode?: string }).errorCode).toBe('PASSWORD_RESET_INVALID');
  });

  test('reset for user with EXISTING CREDENTIALS: dedupes (no duplicate CREDENTIALS entry)', async () => {
    const { plainToken, hashedToken } = generateVerificationToken();
    const user = await makeUser({
      email: 'rdup@example.com',
      passwordResetToken: hashedToken,
      passwordResetExpiry: new Date(Date.now() + 60_000),
      authProviders: [{ provider: AuthProvider.CREDENTIALS }],
    });

    const { req, res } = buildReqRes({
      body: { email: 'rdup@example.com', token: plainToken, newPassword: 'new-pw-12345' },
    });
    await invokeController(resetPasswordController, req, res);

    const after = await UserModel.findById(user._id).select('authProviders');
    expect(after?.authProviders.filter((p) => p.provider === AuthProvider.CREDENTIALS)).toHaveLength(1);
  });
});

// ── setPasswordController ─────────────────────────────

describe('setPasswordController', () => {
  beforeEach(() => {
    consumeMock.mockReset();
    consumeMock.mockResolvedValue(undefined); // happy path: code valid
  });

  test('Google-only user (no CREDENTIALS, no password): password set + CREDENTIALS added + tokenVersion bumped + fresh token returned', async () => {
    const user = await makeUser({
      email: 'sp@example.com',
      authProviders: [{ provider: AuthProvider.GOOGLE, providerId: 'g1' }],
    });
    // makeUser hashes a default password — strip it for this test
    await UserModel.updateOne({ _id: user._id }, { $unset: { password: '' } });

    const { req, res, status, json } = buildReqRes({
      userId: user._id.toString(),
      body: { newPassword: 'set-pw-12345', code: '123456' },
    });
    await invokeController(setPasswordController, req, res);
    expect(status).toHaveBeenCalledWith(200);

    const after = await UserModel.findById(user._id).select('+password authProviders tokenVersion');
    expect(after?.password).toBeTruthy();
    expect(after?.tokenVersion).toBe(user.tokenVersion + 1);
    const creds = after?.authProviders.filter((p) => p.provider === AuthProvider.CREDENTIALS);
    expect(creds).toHaveLength(1);
    expect(consumeMock).toHaveBeenCalledWith({
      userId: user._id.toString(),
      action: 'set_password',
      code: '123456',
    });

    // The response carries a fresh JWT bound to the new tokenVersion so the
    // calling session can stay alive without re-authenticating.
    const body = json.mock.calls[0]?.[0] as { data?: { token?: string } };
    expect(typeof body?.data?.token).toBe('string');
    expect(body.data!.token!.length).toBeGreaterThan(20);
  });

  test('user already has a password → 400 PASSWORD_ALREADY_SET', async () => {
    const user = await makeUser({ email: 'spset@example.com' }); // makeUser sets a password by default
    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { newPassword: 'nope-pw-12345', code: '123456' },
    });
    let caught: unknown;
    try {
      await invokeController(setPasswordController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(400);
    expect((caught as { errorCode?: string }).errorCode).toBe('PASSWORD_ALREADY_SET');
  });

  test('user has CREDENTIALS provider (even without password) → 400 PASSWORD_ALREADY_SET', async () => {
    const user = await makeUser({
      email: 'spcred@example.com',
      authProviders: [{ provider: AuthProvider.CREDENTIALS }],
    });
    // Strip the password but keep CREDENTIALS
    await UserModel.updateOne({ _id: user._id }, { $unset: { password: '' } });

    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { newPassword: 'nope-pw-12345', code: '123456' },
    });
    let caught: unknown;
    try {
      await invokeController(setPasswordController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(400);
    expect((caught as { errorCode?: string }).errorCode).toBe('PASSWORD_ALREADY_SET');
  });

  test('unknown userId → 401', async () => {
    const { req, res, status } = buildReqRes({
      userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      body: { newPassword: 'set-pw-12345', code: '123456' },
    });
    await expect(invokeController(setPasswordController, req, res)).rejects.toThrow('Unauthorized');
    expect(status).toHaveBeenCalledWith(401);
  });

  test('invalid OTP code → 400 SECURITY_CODE_INVALID; no password set', async () => {
    consumeMock.mockRejectedValueOnce(
      new AppError('Confirmation code is incorrect.', {
        errorCode: 'SECURITY_CODE_INVALID',
        statusCode: 400,
      }),
    );

    const user = await makeUser({
      email: 'sp-bad-code@example.com',
      authProviders: [{ provider: AuthProvider.GOOGLE, providerId: 'g1' }],
    });
    await UserModel.updateOne({ _id: user._id }, { $unset: { password: '' } });

    const { req, res } = buildReqRes({
      userId: user._id.toString(),
      body: { newPassword: 'should-not-apply-1', code: '999999' },
    });
    await expect(invokeController(setPasswordController, req, res)).rejects.toMatchObject({
      message: expect.stringContaining('incorrect'),
    });

    const after = await UserModel.findById(user._id).select('+password tokenVersion authProviders');
    expect(after?.password).toBeFalsy();
    expect(after?.tokenVersion).toBe(user.tokenVersion);
    const creds = after?.authProviders.filter((p) => p.provider === AuthProvider.CREDENTIALS) ?? [];
    expect(creds).toHaveLength(0);
  });
});

// ── changePasswordController ──────────────────────────

describe('changePasswordController', () => {
  beforeEach(() => {
    consumeMock.mockReset();
    consumeMock.mockResolvedValue(undefined); // happy path: code valid
  });

  test('credentials user: password updated + tokenVersion bumped + fresh token returned', async () => {
    const user = await makeUser({ email: 'cp@example.com' });
    const before = await UserModel.findById(user._id).select('+password').lean();

    const { req, res, status, json } = buildReqRes({
      userId: user._id.toString(),
      body: { newPassword: 'new-pw-12345', code: '123456' },
    });
    await invokeController(changePasswordController, req, res);
    expect(status).toHaveBeenCalledWith(200);

    const after = await UserModel.findById(user._id).select('+password tokenVersion').lean();
    expect(after?.password).not.toBe(before?.password); // hash rotated
    expect(after?.tokenVersion).toBe(user.tokenVersion + 1);
    expect(consumeMock).toHaveBeenCalledWith({
      userId: user._id.toString(),
      action: 'change_password',
      code: '123456',
    });

    // The response carries a fresh JWT bound to the new tokenVersion so the
    // calling session can stay alive without re-authenticating.
    const body = json.mock.calls[0]?.[0] as { data?: { token?: string } };
    expect(typeof body?.data?.token).toBe('string');
    expect(body.data!.token!.length).toBeGreaterThan(20);
  });

  test('Google-only user (no CREDENTIALS provider) → 400 PASSWORD_NOT_SET', async () => {
    const user = await makeUser({
      email: 'cpgoog@example.com',
      authProviders: [{ provider: AuthProvider.GOOGLE, providerId: 'g1' }],
    });
    await UserModel.updateOne({ _id: user._id }, { $unset: { password: '' } });

    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { newPassword: 'nope-pw-12345', code: '123456' },
    });
    let caught: unknown;
    try {
      await invokeController(changePasswordController, req, res);
    } catch (e) {
      caught = e;
    }
    expect(status).toHaveBeenCalledWith(400);
    expect((caught as { errorCode?: string }).errorCode).toBe('PASSWORD_NOT_SET');
  });

  test('unknown userId → 401', async () => {
    const { req, res, status } = buildReqRes({
      userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      body: { newPassword: 'new-pw-12345', code: '123456' },
    });
    await expect(invokeController(changePasswordController, req, res)).rejects.toThrow('Unauthorized');
    expect(status).toHaveBeenCalledWith(401);
  });

  test('invalid OTP code → 400 SECURITY_CODE_INVALID; no password change', async () => {
    consumeMock.mockRejectedValueOnce(
      new AppError('Confirmation code is incorrect.', {
        errorCode: 'SECURITY_CODE_INVALID',
        statusCode: 400,
      }),
    );

    const user = await makeUser({ email: 'cp-bad-code@example.com' });
    const before = await UserModel.findById(user._id).select('+password').lean();
    const { req, res } = buildReqRes({
      userId: user._id.toString(),
      body: { newPassword: 'should-not-apply-1', code: '999999' },
    });
    await expect(invokeController(changePasswordController, req, res)).rejects.toMatchObject({
      message: expect.stringContaining('incorrect'),
    });
    const after = await UserModel.findById(user._id).select('+password tokenVersion').lean();
    expect(after?.password).toBe(before?.password); // unchanged
    expect(after?.tokenVersion).toBe(user.tokenVersion); // unchanged
  });
});
