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
import { PRICING_CONFIG } from '@lib/pricingConfig';

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
    ctx: { userId: '000000000000000000000001', source: 'request' as const, creditBucketAtScope: 'allowance' },
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
    ctx: { userId: '000000000000000000000001', source: 'request' as const, creditBucketAtScope: 'allowance' },
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
  // image:hero is NOT in LESSON_PREMIUM_ACTIONS — even if it runs inside a
  // lesson-generation job, it bills at the `other` rate.
  const otherAllowanceMarkup = PRICING_CONFIG.markup.other.allowance;
  await runWithUsageContext({
    ctx: {
      userId: '000000000000000000000042',
      source: 'job' as const,
      jobId: 'job-123',
      courseId: 'course-abc',
      moduleIndex: 1,
      lessonIndex: 2,
      creditBucketAtScope: 'allowance',
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
  assert.equal(
    doc.chargedMicroCents,
    500_000 * otherAllowanceMarkup,
    `image:hero (supporting call) charges ${otherAllowanceMarkup}× even inside lesson job`,
  );
  // The pricing-version stamp lets historical audits know which markup table
  // this row was billed under. Bumped via `PRICING_VERSION` in pricingConfig.ts.
  assert.equal(doc.pricingVersion, PRICING_CONFIG.pricingVersion);
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
    ctx: { userId: '000000000000000000000001', source: 'request' as const, creditBucketAtScope: 'allowance' },
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

// ── Action-driven single-layer markup ───────────────────

// Markup is resolved per call from the action label, not from the scope.
// Only `lesson:content` qualifies for the lesson premium; every other
// action (including supporting calls inside a lesson job) bills at `other`.

test('mentor:chat on allowance charges MARKUP.other.allowance × vendor', async () => {
  const factor = PRICING_CONFIG.markup.other.allowance;
  createdDocs.length = 0;
  let accumulator = -1;
  await runWithUsageContext({
    ctx: { userId: '000000000000000000000003', source: 'request' as const, creditBucketAtScope: 'allowance' },
    fn: async () => {
      recordUsage({ service: 'anthropic', action: 'mentor:chat', costMicroCents: 1_000 });
      accumulator = getUsageContext()!.spendMicroCents.current;
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(accumulator, 1_000 * factor, `non-lesson actions charge ${factor}× vendor`);
  const doc = createdDocs[0] as Record<string, unknown>;
  assert.equal(doc.costMicroCents, 1_000);
  assert.equal(doc.chargedMicroCents, 1_000 * factor);
});

test('lesson:content on allowance charges MARKUP.lesson.allowance × vendor', async () => {
  const factor = PRICING_CONFIG.markup.lesson.allowance;
  createdDocs.length = 0;
  let accumulator = -1;
  await runWithUsageContext({
    ctx: { userId: '000000000000000000000004', source: 'job' as const, jobId: 'j1', creditBucketAtScope: 'allowance' },
    fn: async () => {
      recordUsage({ service: 'anthropic', action: 'lesson:content', costMicroCents: 10_000 });
      accumulator = getUsageContext()!.spendMicroCents.current;
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(accumulator, 10_000 * factor, `lesson:content on allowance charges ${factor}× vendor`);
});

test('lesson:content on bonus charges MARKUP.lesson.bonus × vendor (top-up tax)', async () => {
  const factor = PRICING_CONFIG.markup.lesson.bonus;
  createdDocs.length = 0;
  let accumulator = -1;
  await runWithUsageContext({
    ctx: { userId: '000000000000000000000005', source: 'job' as const, jobId: 'j2', creditBucketAtScope: 'bonus' },
    fn: async () => {
      recordUsage({ service: 'anthropic', action: 'lesson:content', costMicroCents: 10_000 });
      accumulator = getUsageContext()!.spendMicroCents.current;
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(accumulator, 10_000 * factor, `lesson:content on bonus charges ${factor}× vendor`);
});

test('supporting calls inside a lesson job bill at the OTHER rate, not the lesson rate', async () => {
  // The whole point of action-driven markup: image:hero / lesson:recall /
  // lesson:links.* / search:basic are supporting calls. Even when they fire
  // inside a lesson-generation job, they don't pay the lesson premium —
  // only the singular `lesson:content` call does.
  const otherFactor = PRICING_CONFIG.markup.other.allowance;
  const lessonFactor = PRICING_CONFIG.markup.lesson.allowance;
  createdDocs.length = 0;
  await runWithUsageContext({
    ctx: { userId: '000000000000000000000006', source: 'job' as const, jobId: 'j3', creditBucketAtScope: 'allowance' },
    fn: async () => {
      recordUsage({ service: 'bfl', action: 'image:hero', costMicroCents: 25_000 });
      recordUsage({ service: 'anthropic', action: 'lesson:recall', costMicroCents: 5_000 });
      recordUsage({ service: 'anthropic', action: 'lesson:links.plan', costMicroCents: 3_000 });
      recordUsage({ service: 'tavily', action: 'search:basic', costMicroCents: 8_000 });
      recordUsage({ service: 'anthropic', action: 'lesson:content', costMicroCents: 60_000 });
    },
  });
  await new Promise((r) => setImmediate(r));
  const byAction = Object.fromEntries(
    (createdDocs as Record<string, unknown>[]).map((d) => [d.action as string, d.chargedMicroCents as number]),
  );
  assert.equal(byAction['image:hero'], 25_000 * otherFactor, 'image:hero → other rate');
  assert.equal(byAction['lesson:recall'], 5_000 * otherFactor, 'lesson:recall → other rate');
  assert.equal(byAction['lesson:links.plan'], 3_000 * otherFactor, 'lesson:links.plan → other rate');
  assert.equal(byAction['search:basic'], 8_000 * otherFactor, 'search:basic → other rate');
  assert.equal(byAction['lesson:content'], 60_000 * lessonFactor, 'lesson:content → lesson rate');
});

test('mixed batch: accumulator sums each call at its own action-driven rate', async () => {
  const lessonFactor = PRICING_CONFIG.markup.lesson.allowance;
  const otherFactor = PRICING_CONFIG.markup.other.allowance;
  createdDocs.length = 0;
  let accumulator = -1;
  await runWithUsageContext({
    ctx: { userId: '000000000000000000000007', source: 'job' as const, jobId: 'j4', creditBucketAtScope: 'allowance' },
    fn: async () => {
      recordUsage({ service: 'anthropic', action: 'lesson:content', costMicroCents: 1_000 });   // lesson rate
      recordUsage({ service: 'tavily', action: 'lesson:links.plan', costMicroCents: 2_000 });   // other rate
      recordUsage({ service: 'bfl', action: 'image:hero', costMicroCents: 5_000 });             // other rate
      accumulator = getUsageContext()!.spendMicroCents.current;
    },
  });
  await new Promise((r) => setImmediate(r));
  const expected = 1_000 * lessonFactor + 2_000 * otherFactor + 5_000 * otherFactor;
  assert.equal(accumulator, expected);
  const vendorTotal = createdDocs.reduce<number>(
    (sum, d) => sum + ((d as Record<string, number>).costMicroCents ?? 0),
    0,
  );
  assert.equal(vendorTotal, 8_000, 'vendor-cost ledger preserves real provider spend');
});
