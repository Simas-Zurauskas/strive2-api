/**
 * Self-executing test file for `recordUsage` — the no-op branches plus the
 * happy-path write shape. Stubs `UsageEventModel.create` so the test has no
 * DB dependency, matching the zero-dep style of the other *.test.ts files.
 *
 * Run: yarn test:usage-service
 *
 * Exits 0 on success; assertion failures throw and exit non-zero.
 */

import 'colors';
import assert from 'node:assert/strict';

// Stub the model BEFORE importing the service so `recordUsage` closes over
// the patched `create`. `require` reaches past ESM so we can mutate the
// default export in place.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const UsageEventModel = require('@models/UsageEventModel').default as {
  create: (doc: unknown) => Promise<unknown>;
};

let createdDocs: unknown[] = [];
UsageEventModel.create = async (doc: unknown) => {
  createdDocs.push(doc);
  return doc;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { recordUsage } = require('./usageService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runWithUsageContext } = require('@lib/usageContext');

const main = async () => {
  let passed = 0;
  const test = async (name: string, fn: () => Promise<void> | void) => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  console.log('recordUsage');

  // ── No-op branches ──────────────────────────────────────

  await test('no-op when called outside a usage context', async () => {
    createdDocs = [];
    recordUsage({ service: 'anthropic', action: 'test', costMicroCents: 100 });
    await new Promise((r) => setImmediate(r));
    assert.equal(createdDocs.length, 0, 'no row should be written without an ALS scope');
  });

  await test('no-op when costMicroCents is zero', async () => {
    createdDocs = [];
    await runWithUsageContext({
      ctx: { userId: '000000000000000000000001', source: 'request' as const },
      fn: async () => {
        recordUsage({ service: 'anthropic', action: 'test', costMicroCents: 0 });
      },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(createdDocs.length, 0);
  });

  await test('no-op when costMicroCents is negative', async () => {
    createdDocs = [];
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

  await test('writes a row with merged context metadata', async () => {
    createdDocs = [];
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

  await test('merges metadata without overwriting the ALS-supplied fields', async () => {
    createdDocs = [];
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

  console.log(`\n✓ ${passed} test(s) passed`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
