/**
 * Tests for deleteAccountController. The cascade is wide:
 *   - Per-course content (lessons, quizzes, chats, recall cards, S3) via cleanupCourseContent
 *   - Cross-user favorite cleanup (other users referencing this user's courses)
 *   - Stripe subscription cancellation
 *   - Abuse log row written (with lifetime credit aggregation)
 *   - Credit ledger purged
 *   - User row finally deleted
 *
 * Bugs here orphan rows, leak billing, or skip the abuse defense.
 *
 * Auth model: deletion is gated by an email-OTP flow, NOT by password.
 * The OTP service is mocked here so tests focus on the post-confirmation
 * cascade; the OTP code itself is exercised in securityActionService tests.
 *
 * Run: yarn test deleteAccount
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import { makeUser, makeCourse, makeJob, UserModel, CourseModel, JobModel } from '../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../test-helpers/express';
import { AuthProvider } from '@lib/constants';
import CreditLedgerModel from '@models/CreditLedgerModel';

// Mock Stripe + abuse-log + cleanupCourseContent + securityActionService.
const { fakeCancelAllSubs, fakeRecordDeletion, fakeCleanupCourse, fakeConsumeCode } = vi.hoisted(() => ({
  fakeCancelAllSubs: vi.fn(() => Promise.resolve()),
  fakeRecordDeletion: vi.fn(() => Promise.resolve()),
  fakeCleanupCourse: vi.fn(() => Promise.resolve({})),
  fakeConsumeCode: vi.fn(() => Promise.resolve()),
}));

vi.mock('@services/stripeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/stripeService')>();
  return {
    ...actual,
    cancelAllSubscriptionsForCustomer: fakeCancelAllSubs,
  };
});

vi.mock('@services/abuseLogService', () => ({
  resolveSignupAllowance: vi.fn(),
  recordAccountDeletion: fakeRecordDeletion,
}));

vi.mock('@services/courseCleanupService', () => ({
  cleanupCourseContent: fakeCleanupCourse,
  getEditImpact: vi.fn(),
}));

vi.mock('@services/securityActionService', () => ({
  consumeSecurityActionCode: fakeConsumeCode,
}));

import { deleteAccountController } from '@controlers/auth/deleteAccount';

setupTestDb();

const VALID_CODE = '123456';

beforeEach(() => {
  fakeCancelAllSubs.mockReset();
  fakeCancelAllSubs.mockResolvedValue(undefined);
  fakeRecordDeletion.mockReset();
  fakeRecordDeletion.mockResolvedValue(undefined);
  fakeCleanupCourse.mockReset();
  fakeCleanupCourse.mockResolvedValue({});
  fakeConsumeCode.mockReset();
  fakeConsumeCode.mockResolvedValue(undefined);
});

// ── Happy paths ─────────────────────────────────────────

describe('deleteAccountController — happy paths', () => {
  test('credentials user with valid OTP code: cascade complete + user deleted', async () => {
    const user = await makeUser({
      email: 'del@example.com',
      plainPassword: 'pw12345678',
    });
    const course1 = await makeCourse({ userId: user._id });
    const course2 = await makeCourse({ userId: user._id });
    await makeJob({ userId: user._id, courseId: course1._id });

    const { req, res, status, json } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ data: { deleted: true } });

    // OTP code was consumed exactly once for the right action.
    expect(fakeConsumeCode).toHaveBeenCalledWith({
      userId: user._id.toString(),
      action: 'delete_account',
      code: VALID_CODE,
    });
    // User row gone
    expect(await UserModel.findById(user._id)).toBeNull();
    // Per-course cleanup ran for each course
    expect(fakeCleanupCourse).toHaveBeenCalledTimes(2);
    // Jobs deleted
    expect(await JobModel.countDocuments({ userId: user._id })).toBe(0);
    // Courses deleted
    expect(await CourseModel.countDocuments({ userId: user._id })).toBe(0);
    // Abuse log recorded
    expect(fakeRecordDeletion).toHaveBeenCalledWith({
      email: 'del@example.com',
      userId: user._id,
    });
    // Hint: course2 kept around to verify both cleanups ran (see expect above).
    expect(course2._id.toString()).toBeTruthy();
  });

  test('Google-only user: same OTP-only flow (no password skip path anymore)', async () => {
    const user = await makeUser({
      email: 'goog-del@example.com',
      authProviders: [{ provider: AuthProvider.GOOGLE, providerId: 'g1' }],
    });
    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(await UserModel.findById(user._id)).toBeNull();
  });

  test("cascades favorites pull on OTHER users referencing this user's courses", async () => {
    const owner = await makeUser({ email: 'owner@example.com', plainPassword: 'pw12345678' });
    const course = await makeCourse({ userId: owner._id });

    // Other user has this course favorited
    const peer = await makeUser({ email: 'peer@example.com' });
    await UserModel.updateOne({ _id: peer._id }, { $push: { favoriteCourseIds: course._id } });

    const { req, res } = buildReqRes({
      userId: owner._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res);

    const peerAfter = await UserModel.findById(peer._id).lean();
    expect(peerAfter?.favoriteCourseIds.map((id) => id.toString())).not.toContain(course._id.toString());
  });

  test('credit ledger rows are purged for the deleted user', async () => {
    const user = await makeUser({ email: 'led@example.com', plainPassword: 'pw12345678' });
    await CreditLedgerModel.create({
      userId: user._id,
      timestamp: new Date(),
      delta: 110,
      allowanceDelta: 110,
      bonusDelta: 0,
      balanceBefore: 0,
      balanceAfter: 110,
      bonusBefore: 0,
      bonusAfter: 0,
      reason: 'signup_grant',
    });

    const { req, res } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res);

    expect(await CreditLedgerModel.countDocuments({ userId: user._id })).toBe(0);
  });

  test('user with Stripe customer id: cancelAllSubscriptionsForCustomer fires', async () => {
    const user = await makeUser({ email: 'stripe-del@example.com', plainPassword: 'pw12345678' });
    await UserModel.updateOne({ _id: user._id }, { $set: { 'subscription.stripeCustomerId': 'cus_test_xyz' } });

    const { req, res } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res);

    expect(fakeCancelAllSubs).toHaveBeenCalledWith({ customerId: 'cus_test_xyz' });
  });

  test('user without Stripe customer id: cancelAllSubscriptionsForCustomer NOT called', async () => {
    const user = await makeUser({ email: 'free-del@example.com', plainPassword: 'pw12345678' });
    const { req, res } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res);
    expect(fakeCancelAllSubs).not.toHaveBeenCalled();
  });
});

// ── Failure paths ───────────────────────────────────────

describe('deleteAccountController — failure paths', () => {
  test('invalid OTP code → AppError; no deletion', async () => {
    const { AppError } = await import('@middleware/errorMiddleware');
    fakeConsumeCode.mockRejectedValueOnce(
      new AppError('Confirmation code is incorrect.', {
        errorCode: 'SECURITY_CODE_INVALID',
        statusCode: 400,
      }),
    );
    const user = await makeUser({ email: 'wpw@example.com', plainPassword: 'right-pw-123' });
    const { req, res } = buildReqRes({
      userId: user._id.toString(),
      body: { code: '999999' },
    });
    await expect(invokeController(deleteAccountController, req, res)).rejects.toMatchObject({
      message: expect.stringContaining('incorrect'),
    });
    // Sanity: user still exists
    expect(await UserModel.findById(user._id)).not.toBeNull();
  });

  test('unknown userId → 401 (before OTP check)', async () => {
    const { req, res, status } = buildReqRes({
      userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      body: { code: VALID_CODE },
    });
    await expect(invokeController(deleteAccountController, req, res)).rejects.toThrow();
    expect(status).toHaveBeenCalledWith(401);
    // OTP not consumed for ghost users.
    expect(fakeConsumeCode).not.toHaveBeenCalled();
  });

  test('Stripe cancel throws: deletion still proceeds (right-to-erasure takes priority)', async () => {
    fakeCancelAllSubs.mockRejectedValueOnce(new Error('Stripe down'));
    const user = await makeUser({ email: 'sf@example.com', plainPassword: 'pw12345678' });
    await UserModel.updateOne({ _id: user._id }, { $set: { 'subscription.stripeCustomerId': 'cus_test_fails' } });

    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res); // should not throw
    expect(status).toHaveBeenCalledWith(200);
    expect(await UserModel.findById(user._id)).toBeNull(); // still deleted
  });

  test('abuse-log record throws transiently: retry recovers, deletion proceeds', async () => {
    // Single transient failure → second attempt succeeds. The controller's
    // sync-retry loop swallows the first throw and the cascade still runs.
    fakeRecordDeletion.mockRejectedValueOnce(new Error('AbuseLog write failed'));
    const user = await makeUser({ email: 'ab@example.com', plainPassword: 'pw12345678' });

    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(await UserModel.findById(user._id)).toBeNull();
  });

  test('abuse-log record permanently fails: 503 thrown, user NOT deleted', async () => {
    // Always-rejecting mock → all retries exhaust → controller throws 503.
    // The cascade must not run; otherwise an attacker could farm free
    // credits by re-signing up after deletion since their abuse-log row
    // never landed.
    fakeRecordDeletion.mockRejectedValue(new Error('AbuseLog permanently down'));
    const user = await makeUser({ email: 'pf@example.com', plainPassword: 'pw12345678' });

    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await expect(invokeController(deleteAccountController, req, res)).rejects.toThrow(/temporarily unavailable/);
    expect(status).toHaveBeenCalledWith(503);
    // Critical: the user row + ledger must still exist so the user can retry.
    expect(await UserModel.findById(user._id)).not.toBeNull();
  });
});

// quiet the unused-import linter for the assert utility we keep around
// for parity with sibling test files.
assert.equal(typeof deleteAccountController, 'function');
