/**
 * Tests for the marketing-contact seed (PLAN Phase 3, A2 / A2b / F2 / F14).
 *
 * The seed migrates the existing verified user base into the marketing
 * audience. The rule that MUST hold, and that this file pins:
 *
 *   **An address already unsubscribed in Mailjet is seeded `optedOut: true`
 *   and is never re-subscribed.**
 *
 * Mailjet's `addforce` action explicitly clears an unsubscribe flag, so a
 * blanket migration that touched Mailjet would resurrect people who opted
 * out. Two structural guarantees make that impossible here:
 *   1. the seed performs **zero Mailjet writes** (asserted below), and
 *   2. every write it does perform is monotone toward suppression —
 *      `$setOnInsert` for new rows, and an `optedOut: false → true` flip
 *      for existing rows. Nothing in this file can ever set `optedOut`
 *      back to `false`.
 *
 * Run: yarn test seedMarketingContacts
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser } from '../../test-helpers/factories';
import MarketingContactModel, { findPromotionalAudience } from '@models/MarketingContactModel';
import { MARKETING_EVIDENCE } from '@lib/constants';

// The seed must never touch Mailjet. It does not import this module at
// all — the mock exists so that if someone later wires a Mailjet write
// into the seed, these assertions turn red instead of silently
// resurrecting unsubscribers.
const { fakeSetSubscribed } = vi.hoisted(() => ({ fakeSetSubscribed: vi.fn() }));
vi.mock('@services/mailjetContactService', () => ({
  setPromotionalSubscribed: fakeSetSubscribed,
  getPromotionalSubscribed: vi.fn(),
  deletePromotionalContact: vi.fn(),
  resolvePromotionalListId: vi.fn(),
  syncSuppression: vi.fn(),
  PROMOTIONAL_LIST_NAME: 'promotional',
}));

import { runSeed } from './seed';

setupTestDb();

const NONE: ReadonlySet<string> = new Set<string>();

beforeEach(() => {
  fakeSetSubscribed.mockReset();
});

describe('runSeed — audience selection', () => {
  test('seeds every verified user and skips unverified ones', async () => {
    await makeUser({ email: 'v1@example.com', emailVerified: true });
    await makeUser({ email: 'v2@example.com', emailVerified: true });
    await makeUser({ email: 'unverified@example.com', emailVerified: false });

    const result = await runSeed({ dryRun: false, suppressedEmails: NONE });

    expect(result.eligible).toBe(2);
    expect(result.inserted).toBe(2);
    const emails = (await MarketingContactModel.find().lean()).map((c) => c.email).sort();
    expect(emails).toEqual(['v1@example.com', 'v2@example.com']);
  });

  test('links each contact to its user id so the deletion cascade can find it', async () => {
    const user = await makeUser({ email: 'linked@example.com', emailVerified: true });
    await runSeed({ dryRun: false, suppressedEmails: NONE });
    const row = await MarketingContactModel.findOne({ email: 'linked@example.com' }).lean();
    expect(row?.userId?.toString()).toBe(user._id.toString());
  });

  test('--dry-run counts the cohort and writes nothing', async () => {
    await makeUser({ email: 'dry@example.com', emailVerified: true });
    const result = await runSeed({ dryRun: true, suppressedEmails: NONE });
    expect(result.eligible).toBe(1);
    expect(result.inserted).toBe(0);
    expect(await MarketingContactModel.countDocuments({})).toBe(0);
  });
});

describe('runSeed — lawful basis (A2 / F14)', () => {
  test('never writes basis "consent" — we do not fabricate a consent nobody gave', async () => {
    await makeUser({ email: 'basis@example.com', emailVerified: true });
    await runSeed({ dryRun: false, suppressedEmails: NONE });
    expect(await MarketingContactModel.countDocuments({ basis: 'consent' })).toBe(0);
    expect(await MarketingContactModel.countDocuments({ basis: 'soft_opt_in' })).toBe(1);
  });

  test('the seeded cohort carries the residual-risk evidence, never the signup notice', async () => {
    await makeUser({ email: 'ev@example.com', emailVerified: true });
    await runSeed({ dryRun: false, suppressedEmails: NONE });
    const row = await MarketingContactModel.findOne({ email: 'ev@example.com' }).lean();
    // These users registered before the at-collection notice existed;
    // claiming otherwise would be a fabricated provenance record.
    expect(row?.evidence).toBe(MARKETING_EVIDENCE.SEEDED_COHORT);
    expect(row?.evidence).not.toBe(MARKETING_EVIDENCE.SIGNUP_NOTICE);
    expect(row?.source).toBe('registration');
  });
});

describe('runSeed — idempotency', () => {
  test('running twice yields the same counts and inserts nothing the second time', async () => {
    await makeUser({ email: 'i1@example.com', emailVerified: true });
    await makeUser({ email: 'i2@example.com', emailVerified: true });

    const first = await runSeed({ dryRun: false, suppressedEmails: NONE });
    const second = await runSeed({ dryRun: false, suppressedEmails: NONE });

    expect(first.eligible).toBe(second.eligible);
    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(await MarketingContactModel.countDocuments({})).toBe(2);
  });

  test('a re-run never overwrites a basis the user themselves upgraded to consent', async () => {
    await makeUser({ email: 'up@example.com', emailVerified: true });
    await runSeed({ dryRun: false, suppressedEmails: NONE });

    // User later ticks the profile toggle: soft_opt_in → consent.
    await MarketingContactModel.updateOne(
      { email: 'up@example.com' },
      { $set: { basis: 'consent', source: 'profile_toggle', evidence: MARKETING_EVIDENCE.PROFILE_TOGGLE } },
    );

    await runSeed({ dryRun: false, suppressedEmails: NONE });

    const row = await MarketingContactModel.findOne({ email: 'up@example.com' }).lean();
    expect(row?.basis).toBe('consent');
    expect(row?.evidence).toBe(MARKETING_EVIDENCE.PROFILE_TOGGLE);
  });
});

describe('runSeed — A2b: an unsubscriber is never resurrected', () => {
  test('an address already unsubscribed in Mailjet is seeded optedOut:true and stays out of the audience', async () => {
    await makeUser({ email: 'gone@example.com', emailVerified: true });
    await makeUser({ email: 'stays@example.com', emailVerified: true });

    const result = await runSeed({
      dryRun: false,
      suppressedEmails: new Set(['gone@example.com']),
    });

    const gone = await MarketingContactModel.findOne({ email: 'gone@example.com' }).lean();
    expect(gone?.optedOut).toBe(true);
    expect(gone?.optedOutAt).toBeInstanceOf(Date);
    expect(result.seededOptedOut).toBe(1);

    const audience = (await findPromotionalAudience()).map((c) => c.email);
    expect(audience).toEqual(['stays@example.com']);
  });

  test('the seed performs NO Mailjet writes — `addforce` (which clears unsub flags) is never reachable', async () => {
    await makeUser({ email: 'nowrite@example.com', emailVerified: true });
    await runSeed({ dryRun: false, suppressedEmails: new Set(['nowrite@example.com']) });
    expect(fakeSetSubscribed).not.toHaveBeenCalled();
  });

  test('an ALREADY-SEEDED row whose address has since unsubscribed is flipped to optedOut', async () => {
    // The `$setOnInsert` path cannot cover this: the row already exists, so
    // a plain re-seed would leave `optedOut: false` and quietly re-admit
    // someone who unsubscribed on Mailjet's hosted page after seeding.
    await makeUser({ email: 'later@example.com', emailVerified: true });
    await runSeed({ dryRun: false, suppressedEmails: NONE });
    expect((await MarketingContactModel.findOne({ email: 'later@example.com' }).lean())?.optedOut).toBe(false);

    const result = await runSeed({
      dryRun: false,
      suppressedEmails: new Set(['later@example.com']),
    });

    expect(result.suppressionFlipped).toBe(1);
    const row = await MarketingContactModel.findOne({ email: 'later@example.com' }).lean();
    expect(row?.optedOut).toBe(true);
    expect(await findPromotionalAudience()).toHaveLength(0);
  });

  test('suppression is monotone: a contact never flips back from optedOut to subscribed', async () => {
    await makeUser({ email: 'stay-out@example.com', emailVerified: true });
    await runSeed({ dryRun: false, suppressedEmails: new Set(['stay-out@example.com']) });

    // Mailjet now reports NOBODY suppressed (e.g. the contact was deleted
    // from the list). The seed must still not re-subscribe our row.
    await runSeed({ dryRun: false, suppressedEmails: NONE });

    const row = await MarketingContactModel.findOne({ email: 'stay-out@example.com' }).lean();
    expect(row?.optedOut).toBe(true);
    expect(await findPromotionalAudience()).toHaveLength(0);
  });

  test('a dry run reports the suppression impact without writing it', async () => {
    await makeUser({ email: 'dry-sup@example.com', emailVerified: true });
    const result = await runSeed({
      dryRun: true,
      suppressedEmails: new Set(['dry-sup@example.com']),
    });
    expect(result.eligible).toBe(1);
    expect(result.seededOptedOut).toBe(1);
    expect(await MarketingContactModel.countDocuments({})).toBe(0);
  });
});
