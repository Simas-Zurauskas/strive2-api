/**
 * Tests for deleteAccountController. The cascade is wide:
 *   - Per-course content (lessons, quizzes, chats, insights, S3) via cleanupCourseContent
 *   - Cross-user favorite cleanup (other users referencing this user's courses)
 *   - Stripe subscription cancellation
 *   - Abuse log row written (with lifetime credit aggregation)
 *   - Credit ledger purged
 *   - User row finally deleted
 *
 * Bugs here orphan rows, leak billing, or skip the abuse defense.
 *
 * Run: yarn test deleteAccount
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import {
  makeUser,
  makeCourse,
  makeJob,
  UserModel,
  CourseModel,
  JobModel,
} from '../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../test-helpers/express';
import { AuthProvider } from '@lib/constants';
import CreditLedgerModel from '@models/CreditLedgerModel';

// Mock Stripe + abuse-log + cleanupCourseContent so we can spy on each call.
const { fakeCancelAllSubs, fakeRecordDeletion, fakeCleanupCourse } = vi.hoisted(() => ({
  fakeCancelAllSubs: vi.fn(() => Promise.resolve()),
  fakeRecordDeletion: vi.fn(() => Promise.resolve()),
  fakeCleanupCourse: vi.fn(() => Promise.resolve({})),
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

import { deleteAccountController } from '@controlers/auth/deleteAccount';

setupTestDb();

beforeEach(() => {
  fakeCancelAllSubs.mockReset();
  fakeCancelAllSubs.mockResolvedValue(undefined);
  fakeRecordDeletion.mockReset();
  fakeRecordDeletion.mockResolvedValue(undefined);
  fakeCleanupCourse.mockReset();
  fakeCleanupCourse.mockResolvedValue({});
});

// ── Happy paths ─────────────────────────────────────────

describe('deleteAccountController — happy paths', () => {
  test('credentials user with valid password: cascade complete + user deleted', async () => {
    const user = await makeUser({
      email: 'del@example.com',
      plainPassword: 'pw12345678',
    });
    const course1 = await makeCourse({ userId: user._id });
    const course2 = await makeCourse({ userId: user._id });
    await makeJob({ userId: user._id, courseId: course1._id });

    const { req, res, status, json } = buildReqRes({
      userId: user._id.toString(),
      body: { password: 'pw12345678' },
    });
    await invokeController(deleteAccountController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ data: { deleted: true } });

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
  });

  test('Google-only user: no password required → cascades without comparePassword check', async () => {
    const user = await makeUser({
      email: 'goog-del@example.com',
      authProviders: [{ provider: AuthProvider.GOOGLE, providerId: 'g1' }],
    });
    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: {}, // no password — would fail Zod for credentials user
    });
    await invokeController(deleteAccountController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(await UserModel.findById(user._id)).toBeNull();
  });

  test('cascades favorites pull on OTHER users referencing this user\'s courses', async () => {
    const owner = await makeUser({ email: 'owner@example.com', plainPassword: 'pw12345678' });
    const course = await makeCourse({ userId: owner._id });

    // Other user has this course favorited
    const peer = await makeUser({ email: 'peer@example.com' });
    await UserModel.updateOne(
      { _id: peer._id },
      { $push: { favoriteCourseIds: course._id } },
    );

    const { req, res } = buildReqRes({
      userId: owner._id.toString(),
      body: { password: 'pw12345678' },
    });
    await invokeController(deleteAccountController, req, res);

    const peerAfter = await UserModel.findById(peer._id).lean();
    expect(peerAfter?.favoriteCourseIds.map((id) => id.toString())).not.toContain(
      course._id.toString(),
    );
  });

  test('credit ledger rows are purged for the deleted user', async () => {
    const user = await makeUser({ email: 'led@example.com', plainPassword: 'pw12345678' });
    await CreditLedgerModel.create({
      userId: user._id,
      timestamp: new Date(),
      delta: 130,
      allowanceDelta: 130,
      bonusDelta: 0,
      balanceBefore: 0,
      balanceAfter: 130,
      bonusBefore: 0,
      bonusAfter: 0,
      reason: 'signup_grant',
    });

    const { req, res } = buildReqRes({
      userId: user._id.toString(),
      body: { password: 'pw12345678' },
    });
    await invokeController(deleteAccountController, req, res);

    expect(await CreditLedgerModel.countDocuments({ userId: user._id })).toBe(0);
  });

  test('user with Stripe customer id: cancelAllSubscriptionsForCustomer fires', async () => {
    const user = await makeUser({ email: 'stripe-del@example.com', plainPassword: 'pw12345678' });
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { 'subscription.stripeCustomerId': 'cus_test_xyz' } },
    );

    const { req, res } = buildReqRes({
      userId: user._id.toString(),
      body: { password: 'pw12345678' },
    });
    await invokeController(deleteAccountController, req, res);

    expect(fakeCancelAllSubs).toHaveBeenCalledWith({ customerId: 'cus_test_xyz' });
  });

  test('user without Stripe customer id: cancelAllSubscriptionsForCustomer NOT called', async () => {
    const user = await makeUser({ email: 'free-del@example.com', plainPassword: 'pw12345678' });
    const { req, res } = buildReqRes({
      userId: user._id.toString(),
      body: { password: 'pw12345678' },
    });
    await invokeController(deleteAccountController, req, res);
    expect(fakeCancelAllSubs).not.toHaveBeenCalled();
  });
});

// ── Failure paths ───────────────────────────────────────

describe('deleteAccountController — failure paths', () => {
  test('credentials user with WRONG password → 401, no deletion', async () => {
    const user = await makeUser({ email: 'wpw@example.com', plainPassword: 'right-pw-123' });
    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { password: 'wrong-pw-456' },
    });
    await expect(invokeController(deleteAccountController, req, res)).rejects.toThrow('Invalid password');
    expect(status).toHaveBeenCalledWith(401);
    // Sanity: user still exists
    expect(await UserModel.findById(user._id)).not.toBeNull();
  });

  test('unknown userId → 401', async () => {
    const { req, res, status } = buildReqRes({
      userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      body: { password: 'whatever' },
    });
    await expect(invokeController(deleteAccountController, req, res)).rejects.toThrow();
    expect(status).toHaveBeenCalledWith(401);
  });

  test('Stripe cancel throws: deletion still proceeds (right-to-erasure takes priority)', async () => {
    fakeCancelAllSubs.mockRejectedValueOnce(new Error('Stripe down'));
    const user = await makeUser({ email: 'sf@example.com', plainPassword: 'pw12345678' });
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { 'subscription.stripeCustomerId': 'cus_test_fails' } },
    );

    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { password: 'pw12345678' },
    });
    await invokeController(deleteAccountController, req, res); // should not throw
    expect(status).toHaveBeenCalledWith(200);
    expect(await UserModel.findById(user._id)).toBeNull(); // still deleted
  });

  test('abuse-log record throws: deletion still proceeds + user row gone', async () => {
    fakeRecordDeletion.mockRejectedValueOnce(new Error('AbuseLog write failed'));
    const user = await makeUser({ email: 'ab@example.com', plainPassword: 'pw12345678' });

    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { password: 'pw12345678' },
    });
    await invokeController(deleteAccountController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(await UserModel.findById(user._id)).toBeNull();
  });
});
