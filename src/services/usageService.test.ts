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
import { runWithUsageContext } from '@lib/usageContext';

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
  assert.equal(doc.costMicroCents, 500_000);
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
