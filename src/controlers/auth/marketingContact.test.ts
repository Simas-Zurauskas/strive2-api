/**
 * Tests for the two controllers that WRITE the marketing ledger
 * (PLAN Phase 3, A2 / A4 / F15):
 *
 *   - verifyEmailController            — new signups become emailable at
 *     verification success, recorded against the at-collection notice.
 *   - updateMarketingPreferenceController — an explicit profile toggle is
 *     the only path that may ever write `basis: 'consent'`, and it writes
 *     our ledger BEFORE Mailjet so a vendor failure cannot lose the record.
 *
 * Run: yarn test marketingContact
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import { makeUser, UserModel } from '../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../test-helpers/express';
import { generateVerificationToken } from '@lib/auth';

const { fakeSetSubscribed, fakeGetSubscribed } = vi.hoisted(() => ({
  fakeSetSubscribed: vi.fn(() => Promise.resolve()),
  fakeGetSubscribed: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('@services/mailjetContactService', () => ({
  setPromotionalSubscribed: fakeSetSubscribed,
  getPromotionalSubscribed: fakeGetSubscribed,
  deletePromotionalContact: vi.fn(),
  resolvePromotionalListId: vi.fn(),
  syncSuppression: vi.fn(),
  PROMOTIONAL_LIST_NAME: 'promotional',
}));

import { verifyEmailController } from '@controlers/auth/verifyEmail';
import { updateMarketingPreferenceController } from '@controlers/auth/updateMarketingPreference';
import { getMarketingPreferenceController } from '@controlers/auth/getMarketingPreference';
import MarketingContactModel from '@models/MarketingContactModel';
import { MARKETING_EVIDENCE } from '@lib/constants';

setupTestDb();

beforeEach(() => {
  fakeSetSubscribed.mockReset();
  fakeSetSubscribed.mockResolvedValue(undefined);
  fakeGetSubscribed.mockReset();
  fakeGetSubscribed.mockResolvedValue(false);
});

const makeVerifiableUser = async (email: string) => {
  const { plainToken, hashedToken } = generateVerificationToken();
  const user = await makeUser({
    email,
    emailVerified: false,
    emailVerificationToken: hashedToken,
    emailVerificationExpiry: new Date(Date.now() + 60_000),
  });
  return { user, plainToken };
};

describe('verifyEmailController — marketing contact on verification (A4/F15)', () => {
  test('creates the contact row with the signup-notice evidence and soft opt-in basis', async () => {
    const { plainToken } = await makeVerifiableUser('newsignup@example.com');
    const { req, res, status } = buildReqRes({ body: { token: plainToken } });
    await invokeController(verifyEmailController, req, res);
    expect(status).toHaveBeenCalledWith(200);

    const row = await MarketingContactModel.findOne({ email: 'newsignup@example.com' }).lean();
    expect(row).not.toBeNull();
    expect(row?.basis).toBe('soft_opt_in');
    expect(row?.evidence).toBe(MARKETING_EVIDENCE.SIGNUP_NOTICE);
    expect(row?.source).toBe('signup');
    expect(row?.optedOut).toBe(false);
    // Never a fabricated consent record (A2).
    expect(row?.basis).not.toBe('consent');
  });

  test('does not resurrect an existing opted-out row', async () => {
    await MarketingContactModel.create({
      email: 'returning@example.com',
      basis: 'soft_opt_in',
      source: 'registration',
      evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
      optedOut: true,
      optedOutAt: new Date(),
    });
    const { plainToken } = await makeVerifiableUser('returning@example.com');

    const { req, res } = buildReqRes({ body: { token: plainToken } });
    await invokeController(verifyEmailController, req, res);

    const row = await MarketingContactModel.findOne({ email: 'returning@example.com' }).lean();
    expect(row?.optedOut).toBe(true);
    expect(row?.evidence).toBe(MARKETING_EVIDENCE.SEEDED_COHORT);
  });

  test('a ledger write failure never blocks email verification', async () => {
    const { user, plainToken } = await makeVerifiableUser('ledgerfail@example.com');
    const spy = vi
      .spyOn(MarketingContactModel, 'updateOne')
      .mockRejectedValueOnce(new Error('mongo blip') as never);

    const { req, res, status } = buildReqRes({ body: { token: plainToken } });
    await invokeController(verifyEmailController, req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect((await UserModel.findById(user._id).lean())?.emailVerified).toBe(true);
    spy.mockRestore();
  });
});

describe('updateMarketingPreferenceController — explicit consent (A2)', () => {
  test('opting in writes basis "consent" to our ledger', async () => {
    const user = await makeUser({ email: 'optin@example.com' });
    const { req, res, status } = buildReqRes({
      userId: user._id.toString(),
      body: { subscribed: true },
    });
    await invokeController(updateMarketingPreferenceController, req, res);

    expect(status).toHaveBeenCalledWith(200);
    const row = await MarketingContactModel.findOne({ email: 'optin@example.com' }).lean();
    expect(row?.basis).toBe('consent');
    expect(row?.source).toBe('profile_toggle');
    expect(row?.evidence).toBe(MARKETING_EVIDENCE.PROFILE_TOGGLE);
    expect(row?.optedOut).toBe(false);
    expect(row?.userId?.toString()).toBe(user._id.toString());
  });

  test('opting in upgrades an existing soft opt-in row to consent', async () => {
    const user = await makeUser({ email: 'upgrade@example.com' });
    await MarketingContactModel.create({
      email: 'upgrade@example.com',
      basis: 'soft_opt_in',
      source: 'registration',
      evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
      optedOut: true,
      optedOutAt: new Date(),
    });

    const { req, res } = buildReqRes({ userId: user._id.toString(), body: { subscribed: true } });
    await invokeController(updateMarketingPreferenceController, req, res);

    const row = await MarketingContactModel.findOne({ email: 'upgrade@example.com' }).lean();
    expect(row?.basis).toBe('consent');
    // An explicit, contemporaneous opt-in outranks an earlier opt-out.
    expect(row?.optedOut).toBe(false);
  });

  test('opting out marks the ledger optedOut but never records a consent', async () => {
    const user = await makeUser({ email: 'optout@example.com' });
    const { req, res } = buildReqRes({ userId: user._id.toString(), body: { subscribed: false } });
    await invokeController(updateMarketingPreferenceController, req, res);

    const row = await MarketingContactModel.findOne({ email: 'optout@example.com' }).lean();
    expect(row?.optedOut).toBe(true);
    expect(row?.optedOutAt).toBeInstanceOf(Date);
    expect(row?.basis).toBe('soft_opt_in');
  });

  test('the ledger is written BEFORE Mailjet — a vendor failure loses no record', async () => {
    fakeSetSubscribed.mockRejectedValueOnce(new Error('Mailjet down'));
    const user = await makeUser({ email: 'failsafe@example.com' });
    const { req, res } = buildReqRes({ userId: user._id.toString(), body: { subscribed: false } });

    await expect(invokeController(updateMarketingPreferenceController, req, res)).rejects.toThrow();

    // The opt-out survived even though the outbound call blew up.
    const row = await MarketingContactModel.findOne({ email: 'failsafe@example.com' }).lean();
    expect(row?.optedOut).toBe(true);
  });
});

describe('getMarketingPreferenceController — local suppression is honoured', () => {
  test('a locally opted-out contact reads as unsubscribed even if Mailjet says otherwise', async () => {
    fakeGetSubscribed.mockResolvedValue(true);
    const user = await makeUser({ email: 'suppressed@example.com' });
    await MarketingContactModel.create({
      email: 'suppressed@example.com',
      basis: 'soft_opt_in',
      source: 'registration',
      evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
      optedOut: true,
      optedOutAt: new Date(),
    });

    const { req, res, json } = buildReqRes({ userId: user._id.toString() });
    await invokeController(getMarketingPreferenceController, req, res);

    expect(json).toHaveBeenCalledWith({ data: { subscribed: false } });
    // No point paying for the Mailjet round-trip once we know the answer.
    expect(fakeGetSubscribed).not.toHaveBeenCalled();
  });

  test('with no local suppression the Mailjet answer still wins', async () => {
    fakeGetSubscribed.mockResolvedValue(true);
    const user = await makeUser({ email: 'passthrough@example.com' });
    const { req, res, json } = buildReqRes({ userId: user._id.toString() });
    await invokeController(getMarketingPreferenceController, req, res);
    expect(json).toHaveBeenCalledWith({ data: { subscribed: true } });
  });
});
