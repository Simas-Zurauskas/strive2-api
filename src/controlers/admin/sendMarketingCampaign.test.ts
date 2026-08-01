/**
 * Behaviour pins for the bulk promotional send.
 *
 * Everything here is a property that fails silently in production: a CAS
 * that never claims, a claim that is never released, an opted-out contact
 * that slips into a batch, a stale suppression set. All of them look like a
 * successful send from the operator's side, which is why they are asserted
 * against a real (in-memory) database rather than mocked.
 *
 * Run: yarn test sendMarketingCampaign
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../../test-helpers/db';
import { buildReqRes, invokeController } from '../../../test-helpers/express';

const { sendDocumentsFeatureEmail, fetchPromotionalSuppression, assertSenderIdentityComplete } =
  vi.hoisted(() => ({
    sendDocumentsFeatureEmail: vi.fn(),
    fetchPromotionalSuppression: vi.fn(),
    assertSenderIdentityComplete: vi.fn(),
  }));

vi.mock('@services/emailService', () => ({
  sendDocumentsFeatureEmail,
}));

vi.mock('@services/mailjetSuppressionSync', async (importOriginal) => {
  // Spread the original so `MailjetSuppressionUnavailableError` stays the
  // real class the controller instance-checks against.
  const actual = await importOriginal<typeof import('@services/mailjetSuppressionSync')>();
  return { ...actual, fetchPromotionalSuppression };
});

vi.mock('@lib/email/tokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/email/tokens')>();
  // The real guard refuses to send while the postal address and
  // registration number are placeholders — which they are, deliberately.
  // Stubbed here so the rest of the send path stays testable; the guard
  // itself is pinned in `lib/email/templates.test.ts`.
  return { ...actual, assertSenderIdentityComplete };
});

import { sendMarketingCampaignController } from './sendMarketingCampaign';
import {
  listMarketingCampaignClaimsController,
  reclaimMarketingCampaignClaimsController,
} from './marketingCampaignClaims';
import MarketingContactModel from '@models/MarketingContactModel';
import MarketingSendModel from '@models/MarketingSendModel';
import { MailjetSuppressionUnavailableError } from '@services/mailjetSuppressionSync';

setupTestDb();

const CAMPAIGN = 'documents-feature-2026-08';
const ADMIN_ID = new mongoose.Types.ObjectId().toString();

const suppressionOf = (emails: string[] = []) => ({
  suppressed: new Set(emails),
  listId: 1,
  membershipCount: emails.length,
  fetchedAt: new Date(),
});

const seedContact = (email: string, optedOut = false) =>
  MarketingContactModel.create({
    email,
    basis: 'soft_opt_in',
    source: 'registration',
    evidence: 'pre-notice-residual-risk-memo-2026-07',
    optedOut,
  });

interface SendResponse {
  data: {
    campaignKey: string;
    results: { email: string; status: string; error?: string }[];
    sentCount: number;
    skippedCount: number;
    failedCount: number;
    audienceCount: number;
    remainingCount: number;
    suppressedCount: number;
  };
}

const runSend = async (
  body: Record<string, unknown> = { campaignKey: CAMPAIGN, confirm: CAMPAIGN },
): Promise<SendResponse> => {
  const { req, res, json } = buildReqRes({ body, userId: ADMIN_ID });
  await invokeController(sendMarketingCampaignController, req, res);
  return json.mock.calls[0][0] as SendResponse;
};

const statusOf = (payload: SendResponse, email: string): string | undefined =>
  payload.data.results.find((r) => r.email === email)?.status;

beforeEach(async () => {
  sendDocumentsFeatureEmail.mockReset();
  sendDocumentsFeatureEmail.mockResolvedValue(undefined);
  fetchPromotionalSuppression.mockReset();
  fetchPromotionalSuppression.mockResolvedValue(suppressionOf());
  assertSenderIdentityComplete.mockReset();
  await MarketingSendModel.syncIndexes();
});

describe('claim-then-send CAS', () => {
  test('the FIRST send against an empty ledger actually sends (F18 — upsert, not a plain CAS)', async () => {
    await seedContact('a@example.com');
    await seedContact('b@example.com');

    const payload = await runSend();

    expect(payload.data.sentCount).toBe(2);
    expect(sendDocumentsFeatureEmail).toHaveBeenCalledTimes(2);
    const rows = await MarketingSendModel.find({ campaignKey: CAMPAIGN }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'sent' && r.sentAt)).toBe(true);
  });

  test('is idempotent — a repeat batch reports already_sent and makes no second call', async () => {
    await seedContact('a@example.com');

    const first = await runSend();
    expect(first.data.sentCount).toBe(1);

    sendDocumentsFeatureEmail.mockClear();
    const second = await runSend({
      campaignKey: CAMPAIGN,
      confirm: CAMPAIGN,
      emails: ['a@example.com'],
    });

    expect(statusOf(second, 'a@example.com')).toBe('already_sent');
    expect(second.data.sentCount).toBe(0);
    expect(sendDocumentsFeatureEmail).not.toHaveBeenCalled();
    expect(await MarketingSendModel.countDocuments({ campaignKey: CAMPAIGN })).toBe(1);
  });

  test('a send failure rolls the claim back so the address is retried', async () => {
    await seedContact('a@example.com');
    sendDocumentsFeatureEmail.mockRejectedValueOnce(new Error('mailjet 503'));

    const failed = await runSend();
    expect(statusOf(failed, 'a@example.com')).toBe('failed');

    const row = await MarketingSendModel.findOne({ campaignKey: CAMPAIGN }).lean();
    expect(row?.status).toBe('failed');
    expect(row?.claimedAt).toBeUndefined();
    expect(row?.sentAt).toBeUndefined();

    // Retryable, not locked out.
    const retried = await runSend();
    expect(statusOf(retried, 'a@example.com')).toBe('sent');
  });

  test('an undeliverable address is recorded as a hard bounce and excluded from later campaigns', async () => {
    await seedContact('bad@example.com');
    sendDocumentsFeatureEmail.mockRejectedValueOnce(
      new Error('{"ErrorCode":"mj-0013","ErrorMessage":"invalid email"}'),
    );

    const first = await runSend();
    expect(first.data.failedCount).toBe(1);
    const row = await MarketingSendModel.findOne({ email: 'bad@example.com' }).lean();
    expect(row?.status).toBe('hard_bounced');
    // The claim is deliberately NOT released — the address is done.
    expect(row?.claimedAt).toBeDefined();

    sendDocumentsFeatureEmail.mockClear();
    const second = await runSend();
    expect(sendDocumentsFeatureEmail).not.toHaveBeenCalled();
    expect(second.data.suppressedCount).toBe(1);
  });
});

describe('audience selection', () => {
  test('an opted-out contact is never selected', async () => {
    await seedContact('in@example.com');
    await seedContact('out@example.com', true);

    const payload = await runSend();

    expect(payload.data.sentCount).toBe(1);
    expect(payload.data.results.map((r) => r.email)).toEqual(['in@example.com']);
    expect(await MarketingSendModel.countDocuments({ email: 'out@example.com' })).toBe(0);
  });

  test('an explicitly named address that is not in the ledger is refused, not created', async () => {
    await seedContact('known@example.com');

    const payload = await runSend({
      campaignKey: CAMPAIGN,
      confirm: CAMPAIGN,
      emails: ['stranger@example.com'],
    });

    expect(statusOf(payload, 'stranger@example.com')).toBe('not_in_audience');
    expect(sendDocumentsFeatureEmail).not.toHaveBeenCalled();
    expect(await MarketingContactModel.countDocuments()).toBe(1);
    expect(await MarketingSendModel.countDocuments()).toBe(0);
  });

  test('an opt-out landing between batches is honoured on the next batch', async () => {
    await seedContact('a@example.com');
    await seedContact('b@example.com');

    const first = await runSend({ campaignKey: CAMPAIGN, confirm: CAMPAIGN, batchSize: 1 });
    expect(first.data.sentCount).toBe(1);
    const firstEmail = first.data.results[0].email;
    const secondEmail = firstEmail === 'a@example.com' ? 'b@example.com' : 'a@example.com';

    await MarketingContactModel.updateOne(
      { email: secondEmail },
      { $set: { optedOut: true, optedOutAt: new Date() } },
    );

    sendDocumentsFeatureEmail.mockClear();
    const second = await runSend();
    expect(second.data.sentCount).toBe(0);
    expect(sendDocumentsFeatureEmail).not.toHaveBeenCalled();
  });

  test('a batch that runs out of wall-clock defers the rest without claiming them', async () => {
    for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) await seedContact(e);

    // Jump the clock past the batch budget after the first recipient, which
    // is the only way to exercise the deadline branch without a 100s test.
    const realNow = Date.now.bind(Date);
    let calls = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      return calls > 3 ? realNow() + 10 * 60 * 1000 : realNow();
    });

    try {
      const payload = await runSend();
      expect(payload.data.results.filter((r) => r.status === 'deferred').length).toBeGreaterThan(0);
      expect(payload.data.sentCount).toBeLessThan(3);
      // A deferred recipient is left completely untouched, so the next batch
      // picks it up through the ordinary path.
      expect(await MarketingSendModel.countDocuments()).toBe(payload.data.sentCount);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('batchSize bounds the batch and the rest stay unclaimed', async () => {
    for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) await seedContact(e);

    const payload = await runSend({ campaignKey: CAMPAIGN, confirm: CAMPAIGN, batchSize: 2 });

    expect(payload.data.sentCount).toBe(2);
    expect(payload.data.remainingCount).toBe(1);
    expect(await MarketingSendModel.countDocuments()).toBe(2);
  });
});

describe('suppression', () => {
  test('is re-read on every batch, not once per campaign', async () => {
    await seedContact('a@example.com');
    await seedContact('b@example.com');

    await runSend({ campaignKey: CAMPAIGN, confirm: CAMPAIGN, batchSize: 1 });
    await runSend({ campaignKey: CAMPAIGN, confirm: CAMPAIGN, batchSize: 1 });

    expect(fetchPromotionalSuppression).toHaveBeenCalledTimes(2);
  });

  test('an address suppressed at the vendor is skipped without a send or a ledger row', async () => {
    await seedContact('unsubbed@example.com');
    fetchPromotionalSuppression.mockResolvedValue(suppressionOf(['unsubbed@example.com']));

    const payload = await runSend();

    expect(payload.data.sentCount).toBe(0);
    expect(payload.data.suppressedCount).toBe(1);
    expect(sendDocumentsFeatureEmail).not.toHaveBeenCalled();
    expect(await MarketingSendModel.countDocuments()).toBe(0);
  });

  test('an unreadable suppression list fails the batch closed', async () => {
    await seedContact('a@example.com');
    fetchPromotionalSuppression.mockRejectedValue(
      new MailjetSuppressionUnavailableError('vendor down'),
    );

    const { req, res } = buildReqRes({
      body: { campaignKey: CAMPAIGN, confirm: CAMPAIGN },
      userId: ADMIN_ID,
    });
    await expect(invokeController(sendMarketingCampaignController, req, res)).rejects.toThrow(
      /suppression list/i,
    );
    expect(sendDocumentsFeatureEmail).not.toHaveBeenCalled();
  });
});

describe('guards', () => {
  test('a mismatched confirmation refuses the batch', async () => {
    await seedContact('a@example.com');
    const { req, res } = buildReqRes({
      body: { campaignKey: CAMPAIGN, confirm: 'oops' },
      userId: ADMIN_ID,
    });
    await expect(invokeController(sendMarketingCampaignController, req, res)).rejects.toThrow(
      /Confirmation text/,
    );
    expect(sendDocumentsFeatureEmail).not.toHaveBeenCalled();
  });

  test('an unknown campaign key is rejected before anything is read', async () => {
    const { req, res } = buildReqRes({
      body: { campaignKey: 'made-up-campaign', confirm: 'made-up-campaign' },
      userId: ADMIN_ID,
    });
    await expect(invokeController(sendMarketingCampaignController, req, res)).rejects.toThrow();
    expect(fetchPromotionalSuppression).not.toHaveBeenCalled();
  });

  test('the sender-identity guard runs before any recipient is claimed', async () => {
    await seedContact('a@example.com');
    assertSenderIdentityComplete.mockImplementation(() => {
      throw new Error('still placeholders');
    });

    const { req, res } = buildReqRes({
      body: { campaignKey: CAMPAIGN, confirm: CAMPAIGN },
      userId: ADMIN_ID,
    });
    await expect(invokeController(sendMarketingCampaignController, req, res)).rejects.toThrow(
      /still placeholders/,
    );
    expect(await MarketingSendModel.countDocuments()).toBe(0);
  });
});

describe('stranded claims (F11)', () => {
  const strand = async (email: string, ageMs: number) => {
    await MarketingSendModel.create({
      campaignKey: CAMPAIGN,
      email,
      status: 'claiming',
      claimedAt: new Date(Date.now() - ageMs),
      attempts: 1,
    });
  };

  test('an old in-flight claim is reported, a fresh one is not', async () => {
    await strand('old@example.com', 60 * 60 * 1000);
    await strand('fresh@example.com', 5_000);

    const { req, res, json } = buildReqRes({
      query: { campaignKey: CAMPAIGN },
      userId: ADMIN_ID,
    });
    await invokeController(listMarketingCampaignClaimsController, req, res);
    const payload = json.mock.calls[0][0] as {
      data: { strandedClaims: { email: string }[] };
    };

    expect(payload.data.strandedClaims.map((c) => c.email)).toEqual(['old@example.com']);
  });

  test('reclaim frees the stranded claim so the next batch retries it', async () => {
    await seedContact('old@example.com');
    await strand('old@example.com', 60 * 60 * 1000);

    // Blocked before the reclaim.
    const blocked = await runSend();
    expect(blocked.data.sentCount).toBe(0);
    expect(sendDocumentsFeatureEmail).not.toHaveBeenCalled();

    const { req, res, json } = buildReqRes({
      body: { campaignKey: CAMPAIGN },
      userId: ADMIN_ID,
    });
    await invokeController(reclaimMarketingCampaignClaimsController, req, res);
    expect((json.mock.calls[0][0] as { data: { reclaimedCount: number } }).data.reclaimedCount).toBe(
      1,
    );

    const retried = await runSend();
    expect(statusOf(retried, 'old@example.com')).toBe('sent');
  });

  test('reclaim never touches a delivered row', async () => {
    await MarketingSendModel.create({
      campaignKey: CAMPAIGN,
      email: 'done@example.com',
      status: 'sent',
      claimedAt: new Date(Date.now() - 60 * 60 * 1000),
      sentAt: new Date(Date.now() - 60 * 60 * 1000),
      attempts: 1,
    });

    const { req, res } = buildReqRes({ body: { campaignKey: CAMPAIGN }, userId: ADMIN_ID });
    await invokeController(reclaimMarketingCampaignClaimsController, req, res);

    const row = await MarketingSendModel.findOne({ email: 'done@example.com' }).lean();
    expect(row?.status).toBe('sent');
    expect(row?.claimedAt).toBeDefined();
  });
});
