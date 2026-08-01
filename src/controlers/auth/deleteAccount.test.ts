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
import { AppError } from '@middleware/errorMiddleware';

// Mock Stripe + abuse-log + cleanupCourseContent/Sources + securityActionService.
const { fakeCancelAllSubs, fakeRecordDeletion, fakeCleanupCourse, fakeCleanupSources, fakeConsumeCode, fakeDeleteByPrefix } = vi.hoisted(() => ({
  fakeCancelAllSubs: vi.fn(() => Promise.resolve()),
  fakeRecordDeletion: vi.fn(() => Promise.resolve()),
  fakeCleanupCourse: vi.fn(() => Promise.resolve({})),
  fakeCleanupSources: vi.fn(() => Promise.resolve({ documentsDeleted: 0, chunksDeleted: 0, vectorsDeleted: 0, s3ObjectsDeleted: 0 })),
  fakeConsumeCode: vi.fn(() => Promise.resolve()),
  fakeDeleteByPrefix: vi.fn(() => Promise.resolve(0)),
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
  cleanupCourseSources: fakeCleanupSources,
  getEditImpact: vi.fn(),
}));

vi.mock('@services/securityActionService', () => ({
  consumeSecurityActionCode: fakeConsumeCode,
}));

// Mailjet erasure is a real HTTP call in the un-mocked module; stub the whole
// contact service so the cascade tests stay offline.
vi.mock('@services/mailjetContactService', () => ({
  deletePromotionalContact: vi.fn(() => Promise.resolve()),
  setPromotionalSubscribed: vi.fn(),
  getPromotionalSubscribed: vi.fn(),
  resolvePromotionalListId: vi.fn(),
  syncSuppression: vi.fn(),
  PROMOTIONAL_LIST_NAME: 'promotional',
}));

vi.mock('@services/s3Service', () => ({
  deleteByPrefix: fakeDeleteByPrefix,
  uploadBuffer: vi.fn(),
  getPresignedUrl: vi.fn(),
  objectExists: vi.fn(),
  copyObject: vi.fn(),
  deleteObject: vi.fn(),
  getObjectBuffer: vi.fn(),
  listKeysByPrefix: vi.fn(() => Promise.resolve([])),
  resolveImageUrl: vi.fn(),
}));

// The user-scoped chunk backstop (sourceDocRagService.deleteSourceChunksForUser)
// runs for real against the memory server; only Pinecone is stubbed.
vi.mock('@lib/pinecone', () => ({
  upsertChunkVectors: vi.fn(() => Promise.resolve(true)),
  deleteChunkVectorsByIds: vi.fn(() => Promise.resolve(true)),
  queryChunks: vi.fn(() => Promise.resolve([])),
  upsertVectors: vi.fn(() => Promise.resolve(true)),
  queryVectors: vi.fn(() => Promise.resolve([])),
  deleteVectorsByIds: vi.fn(() => Promise.resolve(true)),
  fetchVectorIds: vi.fn(() => Promise.resolve([])),
  isPineconeEnabled: () => true,
}));

import { deleteAccountController } from '@controlers/auth/deleteAccount';
import MarketingContactModel from '@models/MarketingContactModel';
import { MARKETING_EVIDENCE } from '@lib/constants';
import SourceDocumentModel from '@models/SourceDocumentModel';
import SourceDocumentChunkModel from '@models/SourceDocumentChunkModel';
import ContentFlagModel from '@models/ContentFlagModel';
import mongoose from 'mongoose';

setupTestDb();

const VALID_CODE = '123456';

beforeEach(() => {
  fakeCancelAllSubs.mockReset();
  fakeCancelAllSubs.mockResolvedValue(undefined);
  fakeRecordDeletion.mockReset();
  fakeRecordDeletion.mockResolvedValue(undefined);
  fakeCleanupCourse.mockReset();
  fakeCleanupCourse.mockResolvedValue({});
  fakeCleanupSources.mockReset();
  fakeCleanupSources.mockResolvedValue({ documentsDeleted: 0, chunksDeleted: 0, vectorsDeleted: 0, s3ObjectsDeleted: 0 });
  fakeConsumeCode.mockReset();
  fakeConsumeCode.mockResolvedValue(undefined);
  fakeDeleteByPrefix.mockReset();
  fakeDeleteByPrefix.mockResolvedValue(0);
});

// ── Source-document erasure (Phase 4) ────────────────────

describe('deleteAccountController — source-document erasure', () => {
  test('wipes uploads/{userId}/ prefix + SourceDocument/chunk rows; ContentFlag survives (REPORT Act exception)', async () => {
    const user = await makeUser({ email: 'src-del@example.com' });
    const course = await makeCourse({ userId: user._id });

    const documentId = new mongoose.Types.ObjectId();
    await SourceDocumentModel.create({
      _id: documentId,
      userId: user._id,
      courseId: course._id,
      kind: 'file',
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      byteSize: 10,
      sha256: 'a'.repeat(64),
      s3Key: `uploads/${user._id.toString()}/${course._id.toString()}/${documentId.toString()}`,
      status: 'parsed',
    });
    // FK-drift row: a chunk whose courseId points at a long-gone course —
    // the per-course path can't see it; the user-scoped backstop must.
    await SourceDocumentChunkModel.create({
      userId: user._id,
      courseId: new mongoose.Types.ObjectId(),
      documentId,
      chunkIndex: 0,
      chunkType: 'text',
      text: 'chunk',
      headingPath: [],
      pageRange: null,
      vectorId: `doc:x:${documentId.toString()}:0`,
    });
    await ContentFlagModel.create({
      userId: user._id,
      courseId: course._id,
      documentId,
      provider: 'photodna',
      matchMeta: {},
      s3QuarantineKey: `quarantine/${user._id.toString()}/${documentId.toString()}`,
      retentionUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });

    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res);
    expect(status).toHaveBeenCalledWith(200);

    // Per-course source cleanup ran alongside content cleanup.
    expect(fakeCleanupSources).toHaveBeenCalledWith({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });
    // User-scoped backstops: rows + chunks gone even without a course pointer.
    expect(await SourceDocumentModel.countDocuments({ userId: user._id })).toBe(0);
    expect(await SourceDocumentChunkModel.countDocuments({ userId: user._id })).toBe(0);
    // The whole user upload prefix is wiped.
    expect(fakeDeleteByPrefix).toHaveBeenCalledWith(`uploads/${user._id.toString()}/`);
    // ContentFlag is deliberately retained (REPORT Act evidence window).
    expect(await ContentFlagModel.countDocuments({ userId: user._id })).toBe(1);
  });
});

// ── Marketing-ledger erasure (Phase 3 / F13) ─────────────

describe('deleteAccountController — marketing ledger erasure', () => {
  test('deletes the MarketingContact row so the address does not survive inside the send audience', async () => {
    const user = await makeUser({ email: 'mkt-del@example.com' });
    await MarketingContactModel.create({
      userId: user._id,
      email: 'mkt-del@example.com',
      basis: 'soft_opt_in',
      source: 'registration',
      evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
      optedOut: false,
    });
    // A peer's row must survive — the cascade is owner-scoped.
    await MarketingContactModel.create({
      email: 'peer-keep@example.com',
      basis: 'soft_opt_in',
      source: 'registration',
      evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
      optedOut: false,
    });

    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res);
    expect(status).toHaveBeenCalledWith(200);

    expect(await MarketingContactModel.countDocuments({ email: 'mkt-del@example.com' })).toBe(0);
    expect(await MarketingContactModel.countDocuments({ email: 'peer-keep@example.com' })).toBe(1);
  });

  test('deletes a contact row that predates the userId link (matched on email)', async () => {
    const user = await makeUser({ email: 'orphan-link@example.com' });
    await MarketingContactModel.create({
      email: 'orphan-link@example.com', // no userId — seeded before linkage
      basis: 'soft_opt_in',
      source: 'registration',
      evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
      optedOut: true,
      optedOutAt: new Date(),
    });

    const { req, res } = buildReqRes({ userId: user._id.toString(), body: { code: VALID_CODE } });
    await invokeController(deleteAccountController, req, res);

    expect(await MarketingContactModel.countDocuments({ email: 'orphan-link@example.com' })).toBe(0);
  });

  test('sweeps MarketingSend rows when that collection exists, and is a no-op when it does not (Phase 4 forward guard)', async () => {
    const user = await makeUser({ email: 'send-log@example.com' });
    const db = mongoose.connection.db!;
    await db.collection('MarketingSend').insertMany([
      { campaignKey: 'documents-feature-2026-08', email: 'send-log@example.com', status: 'sent' },
      { campaignKey: 'documents-feature-2026-08', email: 'someone-else@example.com', status: 'sent' },
    ]);

    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { code: VALID_CODE },
    });
    await invokeController(deleteAccountController, req, res);
    expect(status).toHaveBeenCalledWith(200);

    expect(await db.collection('MarketingSend').countDocuments({ email: 'send-log@example.com' })).toBe(0);
    expect(await db.collection('MarketingSend').countDocuments({})).toBe(1);

    // Second user, collection now dropped: the cascade must not throw.
    await db.collection('MarketingSend').drop();
    const other = await makeUser({ email: 'no-send-log@example.com' });
    const second = buildReqRes({ userId: other._id.toString(), body: { code: VALID_CODE } });
    await invokeController(deleteAccountController, second.req, second.res);
    expect(second.status).toHaveBeenCalledWith(200);
  });
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
