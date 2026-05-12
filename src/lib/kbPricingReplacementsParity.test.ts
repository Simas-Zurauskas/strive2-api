import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { PRICING_CONFIG } from './pricingConfig';

/**
 * Drift catcher between api/src/lib/pricingConfig.ts and
 * client/src/lib/pricingSnapshot.ts. The client snapshot is a hand-
 * maintained mirror used at build time to substitute KB placeholders
 * server-side (so the SSR'd HTML has concrete numbers). If pricing knobs
 * change on the api side without the snapshot being updated, the static
 * KB pages will display stale numbers while Pinecone embeds fresh ones.
 *
 * This test parses the client snapshot file as text (no cross-repo
 * import) and verifies the headline knobs match. It's intentionally
 * a string-grep rather than a full TS evaluation — keeps the api-side
 * test independent of the client repo's tsconfig / module resolution.
 */

const CLIENT_SNAPSHOT_PATH = path.resolve(
  __dirname,
  '../../../client/src/lib/pricingSnapshot.ts',
);

let snapshotSource: string;
try {
  snapshotSource = readFileSync(CLIENT_SNAPSHOT_PATH, 'utf-8');
} catch {
  snapshotSource = '';
}

const expectInSnapshot = (needle: string, label: string): void => {
  assert.ok(
    snapshotSource.includes(needle),
    `client/src/lib/pricingSnapshot.ts should contain "${needle}" for ${label} ` +
      `— update the snapshot to match pricingConfig.ts.`,
  );
};

test('client pricing snapshot file exists', () => {
  assert.ok(
    snapshotSource.length > 0,
    `client/src/lib/pricingSnapshot.ts not found at ${CLIENT_SNAPSHOT_PATH}`,
  );
});

test('allowance.unit matches between api and client snapshot', () => {
  expectInSnapshot(`unit: ${PRICING_CONFIG.allowance.unit}`, 'allowance.unit');
});

test('allowance.multipliers match between api and client snapshot', () => {
  for (const [key, mult] of Object.entries(PRICING_CONFIG.allowance.multipliers)) {
    expectInSnapshot(`${key}: ${mult}`, `allowance.multipliers.${key}`);
  }
});

test('monthlyUsd matches for every plan', () => {
  for (const [key, p] of Object.entries(PRICING_CONFIG.planPricing)) {
    expectInSnapshot(`monthlyUsd: ${p.monthlyUsd}`, `${key}.monthlyUsd`);
  }
});

test('topup config matches', () => {
  expectInSnapshot(`creditsPerUsd: ${PRICING_CONFIG.topup.creditsPerUsd}`, 'topup.creditsPerUsd');
  expectInSnapshot(`minUsd: ${PRICING_CONFIG.topup.minUsd}`, 'topup.minUsd');
  expectInSnapshot(`maxUsd: ${PRICING_CONFIG.topup.maxUsd}`, 'topup.maxUsd');
});

test('referenceCosts.lessonCredits matches', () => {
  const [lo, hi] = PRICING_CONFIG.referenceCosts.lessonCredits;
  expectInSnapshot(`lessonCredits: [${lo}, ${hi}]`, 'referenceCosts.lessonCredits');
});

test('referenceCosts.lessonCreditsTopup matches', () => {
  // The top-up control's "$X ≈ N lessons" chips read this. If it drifts
  // from the API-derived value, top-up users see the wrong estimate (the
  // sub-rate count, which overstates lessons-per-dollar by ~25-33%).
  const [lo, hi] = PRICING_CONFIG.referenceCosts.lessonCreditsTopup;
  expectInSnapshot(`lessonCreditsTopup: [${lo}, ${hi}]`, 'referenceCosts.lessonCreditsTopup');
});
