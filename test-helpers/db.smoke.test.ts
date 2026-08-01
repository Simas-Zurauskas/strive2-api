/**
 * Smoke test for the test-helpers themselves — and, since the shared mongod
 * landed, the guard on two production-relevant failure modes:
 *
 *  1. **A corrupted per-file connection.** `setupTestDb()` isolates each test
 *     file on its own database via mongoose's `dbName` connect option. If
 *     someone "simplifies" that back to concatenating a db name onto
 *     `MongoMemoryReplSet.getUri()`, the `?replicaSet=` query string is
 *     mangled and all 46 DB-touching files die on ~30s server-selection
 *     timeouts. The `connection.name` assertion below turns that into one
 *     obvious failing test.
 *
 *  2. **A silently non-transactional test topology.** `lib/dbTransaction.ts`
 *     runs the real `session.withTransaction` only in production, and a
 *     standalone mongod cannot run transactions at all. The money-path proof
 *     in `src/services/creditService.transaction.test.ts` — *a debit is never
 *     written without its ledger row* — is only meaningful if the test server
 *     really is a replica set. If it ever silently isn't, those tests would
 *     pass through the non-transactional branch again and the guarantee would
 *     go back to being unverified. The `hello.setName` + commit/rollback
 *     assertions below are what stops that.
 *
 * Run: yarn test test-helpers
 */

import { describe, test, expect, inject, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb, getTestDbName, ensureCollections } from './db';
import { makeUser, makeCourse, makeJob, UserModel, CourseModel, JobModel } from './factories';

setupTestDb();

// Collections must exist BEFORE the first transactional write — see
// `ensureCollections`.
beforeAll(async () => {
  await ensureCollections(CourseModel);
});

test('makeUser persists a user with sensible defaults', async () => {
  const user = await makeUser();
  expect(user._id).toBeDefined();
  expect(user.emailVerified).toBe(true);
  expect(user.authProviders).toHaveLength(1);
  expect(user.authProviders[0].provider).toBe('CREDENTIALS');
  expect(user.tokenVersion).toBe(0);
  expect(user.subscription.plan).toBe('free');
  expect(user.credits.allowanceBalance).toBeGreaterThan(0);

  const fetched = await UserModel.findById(user._id);
  expect(fetched).not.toBeNull();
});

test('afterEach wipes collections between tests', async () => {
  // First test created a user. This second test should see none.
  const count = await UserModel.countDocuments();
  expect(count).toBe(0);
});

test('makeCourse + makeJob link a job to a course', async () => {
  const user = await makeUser();
  const course = await makeCourse({ userId: user._id });
  const job = await makeJob({ userId: user._id, courseId: course._id });

  expect(job.status).toBe('pending');
  expect(job.type).toBe('generate_lesson');

  const courseFetched = await CourseModel.findById(course._id);
  expect(courseFetched?.userId.toString()).toBe(user._id.toString());

  const jobFetched = await JobModel.findById(job._id);
  expect(jobFetched?.courseId.toString()).toBe(course._id.toString());
});

describe('shared mongod wiring', () => {
  test('globalSetup provided a Mongo URI and it carries a replicaSet parameter', () => {
    const uri = inject('mongoUri');
    expect(typeof uri).toBe('string');
    expect(uri).toMatch(/^mongodb:\/\//);
    expect(uri).toContain('replicaSet=');
  });

  test('this file is connected to its OWN database — not a URI-concatenated one', () => {
    const expected = getTestDbName();
    // The regression this catches: appending the db name to getUri() leaves
    // connection.name as the replica set's generated db, and mangles
    // `?replicaSet=` into the bargain.
    expect(mongoose.connection.name).toBe(expected);
    expect(expected).toMatch(/^t_db_smoke_\d+_\d+_[0-9a-f]{6}$/);
  });

  test('the topology really is a replica set (hello.setName is non-empty)', async () => {
    const db = mongoose.connection.db;
    expect(db).toBeDefined();
    const hello = (await db!.admin().command({ hello: 1 })) as { setName?: string };
    expect(hello.setName).toBeTruthy();
    expect(typeof hello.setName).toBe('string');
  });

  test('session.withTransaction COMMITS — the write survives', async () => {
    const session = await mongoose.startSession();
    let committedId: mongoose.Types.ObjectId | null = null;
    try {
      await session.withTransaction(async () => {
        const [course] = await CourseModel.create(
          [
            {
              userId: new mongoose.Types.ObjectId(),
              name: 'tx-commit',
              slug: `tx-commit-${Date.now()}`,
              goal: 'prove the transaction commits',
              status: 'ready',
            },
          ],
          { session },
        );
        committedId = course._id;
      });
    } finally {
      await session.endSession();
    }

    expect(committedId).not.toBeNull();
    expect(await CourseModel.countDocuments({ _id: committedId })).toBe(1);
  });

  test('session.withTransaction ROLLS BACK when the callback throws — no partial write', async () => {
    const session = await mongoose.startSession();
    const userId = new mongoose.Types.ObjectId();
    const boom = new Error('deliberate rollback');

    await expect(
      (async () => {
        try {
          await session.withTransaction(async () => {
            await CourseModel.create(
              [
                {
                  userId,
                  name: 'tx-rollback',
                  slug: `tx-rollback-${Date.now()}`,
                  goal: 'prove the transaction rolls back',
                  status: 'ready',
                },
              ],
              { session },
            );
            throw boom;
          });
        } finally {
          await session.endSession();
        }
      })(),
    ).rejects.toThrow('deliberate rollback');

    // If this is 1, the transaction did not roll back — which means the
    // server is not really transactional and Phase 4's money proof is void.
    expect(await CourseModel.countDocuments({ userId })).toBe(0);
  });
});
