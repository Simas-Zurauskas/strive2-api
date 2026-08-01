/**
 * Tests for the unsubscribe surface we own (PLAN Phase 3, A12 / F1 / F16).
 *
 * Properties under test:
 *   - it works with NO session (the recipient is a logged-out mail client),
 *   - it is authenticated only by the per-contact HMAC token,
 *   - it is idempotent,
 *   - it NEVER reveals whether an address exists — an unknown, tampered or
 *     absent token produces exactly the response a real one does.
 *
 * Run: yarn test unsubscribeMarketing
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../../test-helpers/db';
import { buildReqRes, invokeController } from '../../../test-helpers/express';

const { fakeSyncSuppression } = vi.hoisted(() => ({
  fakeSyncSuppression: vi.fn(() => Promise.resolve()),
}));

vi.mock('@services/mailjetContactService', () => ({
  syncSuppression: fakeSyncSuppression,
  setPromotionalSubscribed: vi.fn(),
  getPromotionalSubscribed: vi.fn(),
  deletePromotionalContact: vi.fn(),
  resolvePromotionalListId: vi.fn(),
  PROMOTIONAL_LIST_NAME: 'promotional',
}));

import {
  unsubscribeMarketingController,
  unsubscribeMarketingConfirmController,
} from '@controlers/auth/unsubscribeMarketing';
import MarketingContactModel from '@models/MarketingContactModel';
import { buildMarketingUnsubToken } from '@lib/marketingUnsubToken';
import { MARKETING_EVIDENCE } from '@lib/constants';

setupTestDb();

const makeContact = async (email = 'sub@example.com') =>
  MarketingContactModel.create({
    email,
    basis: 'soft_opt_in',
    source: 'registration',
    evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
    optedOut: false,
  });

beforeEach(() => {
  fakeSyncSuppression.mockReset();
  fakeSyncSuppression.mockResolvedValue(undefined);
});

describe('unsubscribeMarketingController — POST (RFC 8058 one-click)', () => {
  test('flips optedOut with no session at all', async () => {
    const contact = await makeContact();
    const token = buildMarketingUnsubToken(contact._id.toString());

    // No userId on the request — this is the whole point.
    const { req, res, status, json } = buildReqRes({ query: { token } });
    expect(req.userId).toBeUndefined();
    await invokeController(unsubscribeMarketingController, req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ data: { unsubscribed: true } });
    const after = await MarketingContactModel.findById(contact._id).lean();
    expect(after?.optedOut).toBe(true);
    expect(after?.optedOutAt).toBeInstanceOf(Date);
  });

  test('propagates the opt-out to Mailjet', async () => {
    const contact = await makeContact('sync@example.com');
    const { req, res } = buildReqRes({ query: { token: buildMarketingUnsubToken(contact._id.toString()) } });
    await invokeController(unsubscribeMarketingController, req, res);
    expect(fakeSyncSuppression).toHaveBeenCalledWith('sync@example.com');
  });

  test('a Mailjet failure does not fail the request — our ledger is authoritative', async () => {
    fakeSyncSuppression.mockRejectedValueOnce(new Error('Mailjet down'));
    const contact = await makeContact('resilient@example.com');
    const { req, res, status } = buildReqRes({
      query: { token: buildMarketingUnsubToken(contact._id.toString()) },
    });
    await invokeController(unsubscribeMarketingController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect((await MarketingContactModel.findById(contact._id).lean())?.optedOut).toBe(true);
  });

  test('is idempotent — a second click succeeds and does not move optedOutAt', async () => {
    const contact = await makeContact();
    const token = buildMarketingUnsubToken(contact._id.toString());

    const first = buildReqRes({ query: { token } });
    await invokeController(unsubscribeMarketingController, first.req, first.res);
    const firstAt = (await MarketingContactModel.findById(contact._id).lean())?.optedOutAt;

    const second = buildReqRes({ query: { token } });
    await invokeController(unsubscribeMarketingController, second.req, second.res);

    expect(second.status).toHaveBeenCalledWith(200);
    const after = await MarketingContactModel.findById(contact._id).lean();
    expect(after?.optedOut).toBe(true);
    expect(after?.optedOutAt?.getTime()).toBe(firstAt?.getTime());
  });

  test('never reveals whether an address exists — unknown, tampered and missing tokens all answer identically', async () => {
    const real = await makeContact('real@example.com');
    const realToken = buildMarketingUnsubToken(real._id.toString());
    const unknownToken = buildMarketingUnsubToken(new mongoose.Types.ObjectId().toString());
    const tampered = `${realToken}x`;

    const responses: unknown[] = [];
    for (const token of [realToken, unknownToken, tampered, undefined]) {
      const { req, res, status, json } = buildReqRes({ query: token ? { token } : {} });
      await invokeController(unsubscribeMarketingController, req, res);
      expect(status).toHaveBeenCalledWith(200);
      responses.push(json.mock.calls[0][0]);
    }
    // Byte-identical bodies for hit and miss (security.md §5.5).
    expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  test('a token signed for another contact does not opt out this one', async () => {
    const a = await makeContact('a@example.com');
    const b = await makeContact('b@example.com');
    const sigOfA = buildMarketingUnsubToken(a._id.toString()).split('.')[1];

    const { req, res, status } = buildReqRes({ query: { token: `${b._id.toString()}.${sigOfA}` } });
    await invokeController(unsubscribeMarketingController, req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect((await MarketingContactModel.findById(a._id).lean())?.optedOut).toBe(false);
    expect((await MarketingContactModel.findById(b._id).lean())?.optedOut).toBe(false);
  });
});

describe('unsubscribeMarketingConfirmController — GET confirmation', () => {
  test('flips optedOut and redirects to the public confirmation page', async () => {
    const contact = await makeContact('get@example.com');
    const { req, res, redirect } = buildReqRes({
      query: { token: buildMarketingUnsubToken(contact._id.toString()) },
    });
    await invokeController(unsubscribeMarketingConfirmController, req, res);

    expect((await MarketingContactModel.findById(contact._id).lean())?.optedOut).toBe(true);
    const target = redirect.mock.calls[0][1] as string;
    expect(target).toMatch(/\/unsubscribed$/);
  });

  test('an unknown token lands on the same page — no existence oracle', async () => {
    const { req, res, redirect } = buildReqRes({
      query: { token: buildMarketingUnsubToken(new mongoose.Types.ObjectId().toString()) },
    });
    await invokeController(unsubscribeMarketingConfirmController, req, res);
    expect(redirect.mock.calls[0][1] as string).toMatch(/\/unsubscribed$/);
  });
});
