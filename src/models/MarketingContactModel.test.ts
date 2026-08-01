/**
 * Tests for MarketingContactModel — the audience + lawful-basis +
 * suppression ledger (PLAN Phase 3).
 *
 * The audience query is the thing that decides who receives a marketing
 * send, so "an opted-out contact is never selected" is the assertion that
 * matters most here.
 *
 * Run: yarn test MarketingContactModel
 */

import { describe, test, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import MarketingContactModel, { findPromotionalAudience } from '@models/MarketingContactModel';
import { MARKETING_EVIDENCE } from '@lib/constants';

setupTestDb();

// Mongoose builds indexes in the background, so without this the unique
// assertion races the index build (same pattern as UserModel.test.ts).
beforeAll(async () => {
  await MarketingContactModel.syncIndexes();
});

const baseContact = (overrides: Record<string, unknown> = {}) => ({
  email: 'a@example.com',
  basis: 'soft_opt_in' as const,
  source: 'registration' as const,
  evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
  optedOut: false,
  ...overrides,
});

describe('MarketingContactModel', () => {
  test('email is unique — a second row for the same address is rejected', async () => {
    await MarketingContactModel.create(baseContact());
    await expect(MarketingContactModel.create(baseContact({ email: 'a@example.com' }))).rejects.toThrow();
  });

  test('email is lowercased on write so the audience cannot hold case-variant duplicates', async () => {
    const row = await MarketingContactModel.create(baseContact({ email: 'MiXeD@Example.COM' }));
    expect(row.email).toBe('mixed@example.com');
  });

  test('basis is enum-constrained — an invented basis is rejected', async () => {
    await expect(
      MarketingContactModel.create(baseContact({ basis: 'legitimate_vibes' })),
    ).rejects.toThrow();
  });

  test('optedOut contacts are excluded from the promotional audience', async () => {
    await MarketingContactModel.create(baseContact({ email: 'in@example.com' }));
    await MarketingContactModel.create(
      baseContact({ email: 'out@example.com', optedOut: true, optedOutAt: new Date() }),
    );
    await MarketingContactModel.create(
      baseContact({ email: 'consented@example.com', basis: 'consent', source: 'profile_toggle' }),
    );

    const audience = await findPromotionalAudience();
    const emails = audience.map((c) => c.email).sort();
    expect(emails).toEqual(['consented@example.com', 'in@example.com']);
    expect(emails).not.toContain('out@example.com');
  });

  test('audience rows carry the contact id, so a per-contact unsubscribe token can be minted', async () => {
    await MarketingContactModel.create(baseContact({ email: 'id@example.com' }));
    const [row] = await findPromotionalAudience();
    expect(mongoose.Types.ObjectId.isValid(row._id.toString())).toBe(true);
  });
});
