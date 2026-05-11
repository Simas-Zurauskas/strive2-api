/**
 * Tests for `recordUsage` — the no-op branches plus the happy-path write
 * shape. `vi.mock` replaces `@models/UsageEventModel` with an in-memory
 * stub so tests have no DB dependency.
 *
 * Run: yarn test usageService
 */

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

// `vi.hoisted` runs BEFORE the (also-hoisted) `vi.mock` factory below, so
// the factory closes over a stable reference. `createdDocs` is shared
// across tests; each test resets `createdDocs.length = 0` instead of
// reassigning so the mock factory keeps working.
const { createdDocs } = vi.hoisted(() => ({ createdDocs: [] as unknown[] }));

vi.mock('@models/UsageEventModel', () => ({
  default: {
    create: async (doc: unknown) => {
      createdDocs.push(doc);
      return doc;
    },
  },
}));

import { recordUsage } from './usageService';
import { runWithUsageContext, getUsageContext } from '@lib/usageContext';

// ── No-op branches ──────────────────────────────────────

test('no-op when called outside a usage context', async () => {
  createdDocs.length = 0;
  recordUsage({ service: 'anthropic', action: 'test', costMicroCents: 100 });
  await new Promise((r) => setImmediate(r));
  assert.equal(createdDocs.length, 0, 'no row should be written without an ALS scope');
});

test('no-op when costMicroCents is zero', async () => {
  createdDocs.length = 0;
  await runWithUsageContext({
    ctx: { userId: '000000000000000000000001', source: 'request' as const },
    fn: async () => {
      recordUsage({ service: 'anthropic', action: 'test', costMicroCents: 0 });
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(createdDocs.length, 0);
});

test('no-op when costMicroCents is negative', async () => {
  createdDocs.length = 0;
  await runWithUsageContext({
    ctx: { userId: '000000000000000000000001', source: 'request' as const },
    fn: async () => {
      recordUsage({ service: 'anthropic', action: 'test', costMicroCents: -1 });
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(createdDocs.length, 0);
});

// ── Happy path ──────────────────────────────────────────

test('writes a row with merged context metadata', async () => {
  createdDocs.length = 0;
  await runWithUsageContext({
    ctx: {
      userId: '000000000000000000000042',
      source: 'job' as const,
      jobId: 'job-123',
      courseId: 'course-abc',
      moduleIndex: 1,
      lessonIndex: 2,
    },
    fn: async () => {
      recordUsage({
        service: 'bfl',
        action: 'image:hero',
        costMicroCents: 500_000,
        metadata: { style: 'watercolor', bytes: 1024 },
      });
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(createdDocs.length, 1);

  const doc = createdDocs[0] as Record<string, unknown>;
  assert.equal(doc.service, 'bfl');
  assert.equal(doc.action, 'image:hero');
  assert.equal(doc.costMicroCents, 500_000, 'vendor cost is preserved as-is');
  assert.equal(doc.chargedMicroCents, 1_000_000, 'BFL is in the markup set → charged at 2× vendor');
  // userId is wrapped in ObjectId — just check it stringifies to the right hex.
  assert.equal(String(doc.userId), '000000000000000000000042');

  const meta = doc.metadata as Record<string, unknown>;
  assert.equal(meta.style, 'watercolor');
  assert.equal(meta.bytes, 1024);
  assert.equal(meta.source, 'job');
  assert.equal(meta.jobId, 'job-123');
  assert.equal(meta.courseId, 'course-abc');
  assert.equal(meta.moduleIndex, 1);
  assert.equal(meta.lessonIndex, 2);
});

test('merges metadata without overwriting the ALS-supplied fields', async () => {
  createdDocs.length = 0;
  await runWithUsageContext({
    ctx: { userId: '000000000000000000000001', source: 'request' as const },
    fn: async () => {
      recordUsage({
        service: 'tavily',
        action: 'search:advanced',
        costMicroCents: 100_000,
        metadata: { query: 'flexbox tutorials' },
      });
    },
  });
  await new Promise((r) => setImmediate(r));
  const meta = (createdDocs[0] as { metadata: Record<string, unknown> }).metadata;
  assert.equal(meta.query, 'flexbox tutorials');
  assert.equal(meta.source, 'request');
  // Absent context fields shouldn't be stamped as undefined keys.
  assert.equal(Object.prototype.hasOwnProperty.call(meta, 'jobId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(meta, 'moduleIndex'), false);
});

// ── Static markup ───────────────────────────────────────

test('anthropic rows: charged === vendor (no markup)', async () => {
  createdDocs.length = 0;
  let accumulator = -1;
  await runWithUsageContext({
    ctx: { userId: '000000000000000000000003', source: 'request' as const },
    fn: async () => {
      recordUsage({ service: 'anthropic', action: 'lesson:content', costMicroCents: 7_500 });
      accumulator = getUsageContext()!.spendMicroCents.current;
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(accumulator, 7_500, 'anthropic is not marked up — accumulator gets vendor cost');
  const doc = createdDocs[0] as Record<string, unknown>;
  assert.equal(doc.costMicroCents, 7_500);
  assert.equal(doc.chargedMicroCents, 7_500);
});

test.each(['judge0', 'tavily', 'jina', 'bfl'] as const)(
  '%s rows: charged is 2× vendor and accumulator increments by the charged amount',
  async (service) => {
    createdDocs.length = 0;
    let accumulator = -1;
    await runWithUsageContext({
      ctx: { userId: '000000000000000000000004', source: 'request' as const },
      fn: async () => {
        recordUsage({ service, action: `${service}:test`, costMicroCents: 4_000 });
        accumulator = getUsageContext()!.spendMicroCents.current;
      },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(accumulator, 8_000, `${service} should debit at 2× vendor`);
    const doc = createdDocs[0] as Record<string, unknown>;
    assert.equal(doc.costMicroCents, 4_000);
    assert.equal(doc.chargedMicroCents, 8_000);
  },
);

test('mixed batch: accumulator equals sum of charged values, ledger preserves vendor', async () => {
  createdDocs.length = 0;
  let accumulator = -1;
  await runWithUsageContext({
    ctx: { userId: '000000000000000000000005', source: 'job' as const, jobId: 'job-mix' },
    fn: async () => {
      recordUsage({ service: 'anthropic', action: 'a', costMicroCents: 1_000 });
      recordUsage({ service: 'tavily', action: 'b', costMicroCents: 2_000 });
      recordUsage({ service: 'bfl', action: 'c', costMicroCents: 5_000 });
      accumulator = getUsageContext()!.spendMicroCents.current;
    },
  });
  await new Promise((r) => setImmediate(r));
  // Anthropic 1× + Tavily 2× + BFL 2× = 1_000 + 4_000 + 10_000 = 15_000.
  assert.equal(accumulator, 15_000);
  const vendorTotal = createdDocs.reduce<number>(
    (sum, d) => sum + ((d as Record<string, number>).costMicroCents ?? 0),
    0,
  );
  assert.equal(vendorTotal, 8_000, 'vendor-cost ledger preserves real provider spend');
});
