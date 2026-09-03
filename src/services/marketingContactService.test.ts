/**
 * Tests for `enrolVerifiedContact`.
 *
 * The bug this closes: Google OAuth signups set `emailVerified: true` directly
 * and never reach `verifyEmail.ts`, which was the only place a
 * `MarketingContact` row was ever created. Google users were therefore created
 * outside the promotional audience entirely.
 *
 * The two properties worth pinning are both about consent, not delivery:
 *   - an existing opt-out must NEVER be resurrected by a re-signup;
 *   - the enrolment must never be able to fail the caller, because both call
 *     sites sit on a user's route into the product.
 *
 * Run: yarn test marketingContactService
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import MarketingContactModel from '@models/MarketingContactModel';
import { MARKETING_EVIDENCE } from '@lib/constants';

const { fakeBgError } = vi.hoisted(() => ({ fakeBgError: vi.fn() }));
vi.mock('@lib/bg', () => ({
  bgError: (context: string) => (err: unknown) => fakeBgError(context, err),
}));

import { enrolVerifiedContact } from '@services/marketingContactService';

setupTestDb();

const EMAIL = 'enrol-probe@example.com';

beforeEach(async () => {
  await MarketingContactModel.deleteMany({});
  fakeBgError.mockReset();
});

describe('enrolVerifiedContact', () => {
  test('creates a contact with the soft-opt-in basis and signup provenance', async () => {
    const userId = new mongoose.Types.ObjectId();
    await enrolVerifiedContact({ userId, email: EMAIL });

    const rows = await MarketingContactModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: EMAIL,
      basis: 'soft_opt_in',
      source: 'signup',
      evidence: MARKETING_EVIDENCE.SIGNUP_NOTICE,
      optedOut: false,
    });
    expect(String(rows[0].userId)).toBe(String(userId));
    expect(fakeBgError).not.toHaveBeenCalled();
  });

  test('NEVER resurrects an opt-out — the consent property', async () => {
    // Someone unsubscribed, then signs in again with Google. Re-enrolling them
    // would mail a person who explicitly asked not to be mailed.
    await MarketingContactModel.create({
      email: EMAIL,
      userId: new mongoose.Types.ObjectId(),
      basis: 'soft_opt_in',
      source: 'signup',
      evidence: MARKETING_EVIDENCE.SIGNUP_NOTICE,
      optedOut: true,
    });

    await enrolVerifiedContact({ userId: new mongoose.Types.ObjectId(), email: EMAIL });

    const rows = await MarketingContactModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].optedOut).toBe(true);
  });

  test('leaves every existing field untouched, not just optedOut', async () => {
    // `$setOnInsert` semantics: an existing row is a no-op in full. If this
    // ever became `$set`, a re-signup would silently rewrite the provenance
    // record that justifies mailing this person at all.
    const originalUser = new mongoose.Types.ObjectId();
    await MarketingContactModel.create({
      email: EMAIL,
      userId: originalUser,
      basis: 'consent',
      source: 'profile_toggle',
      evidence: 'some-older-evidence-v0',
      optedOut: false,
    });

    await enrolVerifiedContact({ userId: new mongoose.Types.ObjectId(), email: EMAIL });

    const row = await MarketingContactModel.findOne({ email: EMAIL }).lean();
    expect(row?.basis).toBe('consent');
    expect(row?.source).toBe('profile_toggle');
    expect(row?.evidence).toBe('some-older-evidence-v0');
    expect(String(row?.userId)).toBe(String(originalUser));
  });

  test('is idempotent — repeated enrolment yields exactly one row', async () => {
    const userId = new mongoose.Types.ObjectId();
    await enrolVerifiedContact({ userId, email: EMAIL });
    await enrolVerifiedContact({ userId, email: EMAIL });
    await enrolVerifiedContact({ userId, email: EMAIL });
    expect(await MarketingContactModel.countDocuments({ email: EMAIL })).toBe(1);
  });

  test('concurrent enrolment of the same address still yields one row', async () => {
    const userId = new mongoose.Types.ObjectId();
    await Promise.all([
      enrolVerifiedContact({ userId, email: EMAIL }),
      enrolVerifiedContact({ userId, email: EMAIL }),
      enrolVerifiedContact({ userId, email: EMAIL }),
    ]);
    expect(await MarketingContactModel.countDocuments({ email: EMAIL })).toBe(1);
  });

  test('a write failure is reported and swallowed — it can never fail the caller', async () => {
    const spy = vi
      .spyOn(MarketingContactModel, 'updateOne')
      .mockRejectedValue(new Error('mongo down') as never);

    await expect(
      enrolVerifiedContact({ userId: new mongoose.Types.ObjectId(), email: EMAIL }),
    ).resolves.toBeUndefined();

    expect(fakeBgError).toHaveBeenCalledOnce();
    expect(fakeBgError.mock.calls[0][0]).toBe('marketingContact.enrolVerifiedContact');
    spy.mockRestore();
  });

  test('a synchronous throw is also swallowed', async () => {
    const spy = vi.spyOn(MarketingContactModel, 'updateOne').mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(
      enrolVerifiedContact({ userId: new mongoose.Types.ObjectId(), email: EMAIL }),
    ).resolves.toBeUndefined();
    expect(fakeBgError).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
