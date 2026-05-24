/**
 * Schema-contract tests for the Stripe-ID unique indexes on UserModel.
 *
 * These exist because of a production E11000: the indexes were `unique +
 * sparse`, but a sparse index still indexes documents whose field is an
 * explicit `null`. The cancel handler wrote `null`, so the second user to
 * cancel collided with the first user's cleared id. The fix is a PARTIAL
 * unique index filtered on `$type: 'string'` — only real ids are indexed;
 * `null` and absent are both excluded.
 *
 * We assert the invariant at the model layer (not just via the webhook
 * flow) so it holds no matter which handler writes these fields, and so a
 * regression to `sparse` is caught directly by the index-spec test.
 *
 * Run: yarn test UserModel
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, UserModel } from '../../test-helpers/factories';

setupTestDb();

// The shared test-db helper leaves index builds lazy; force them so the
// unique constraints are actually present for these assertions. (That
// laziness is exactly why the original bug never tripped a test.)
beforeAll(async () => {
  await UserModel.syncIndexes();
});

describe.each([
  ['subscription.stripeSubscriptionId', 'subscription.stripeSubscriptionId_1'],
  ['subscription.stripeCustomerId', 'subscription.stripeCustomerId_1'],
])('%s unique index', (field, indexName) => {
  test('is partial on $type:string — not sparse', async () => {
    const indexes = await UserModel.collection.indexes();
    const idx = indexes.find((i) => i.name === indexName);
    expect(idx, `index ${indexName} should exist`).toBeDefined();
    expect(idx?.unique).toBe(true);
    // The crux of the fix: a partial filter, and NOT sparse.
    expect(idx?.partialFilterExpression).toEqual({ [field]: { $type: 'string' } });
    expect(idx?.sparse).toBeFalsy();
  });

  test('rejects a duplicate non-null id (uniqueness still enforced)', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await UserModel.updateOne({ _id: a._id }, { $set: { [field]: 'dup_id_1' } });

    await expect(
      UserModel.updateOne({ _id: b._id }, { $set: { [field]: 'dup_id_1' } }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  test('allows many users with the field absent', async () => {
    await makeUser();
    await makeUser();
    await makeUser();
    // No write to `field` at all — all three coexist (free users).
    await expect(UserModel.countDocuments()).resolves.toBe(3);
  });

  test('allows many users with the field explicitly null (the prod-bug case)', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await UserModel.updateOne({ _id: a._id }, { $set: { [field]: null } });
    // Pre-fix (sparse) this second null collides with E11000.
    await expect(
      UserModel.updateOne({ _id: b._id }, { $set: { [field]: null } }),
    ).resolves.toMatchObject({ acknowledged: true });
  });

  test('a user can re-acquire an id after it was cleared (cancel → resubscribe)', async () => {
    const a = await makeUser();
    await UserModel.updateOne({ _id: a._id }, { $set: { [field]: 'reuse_id_1' } });
    // Cancel: clear it (mirrors the handler's $unset).
    await UserModel.updateOne({ _id: a._id }, { $unset: { [field]: '' } });
    // Resubscribe with a fresh id — no stale-null in the way.
    await expect(
      UserModel.updateOne({ _id: a._id }, { $set: { [field]: 'reuse_id_2' } }),
    ).resolves.toMatchObject({ modifiedCount: 1 });
  });
});
