import path from 'node:path';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, expect, inject } from 'vitest';

/**
 * Connect mongoose to the ONE shared, transaction-capable mongod that
 * `test-globalSetup.ts` boots for the whole run, isolating this test file on
 * its own database. Each test starts with empty collections (afterEach drops
 * everything, leaving the schemas/indexes intact).
 *
 * Usage at the top of any test file that touches a model — unchanged, one line:
 *
 *   import { setupTestDb } from '../../test-helpers/db';
 *   setupTestDb();
 *
 * The helper registers vitest hooks (beforeAll / afterEach / afterAll) so call
 * sites stay one line.
 *
 * ── Two things that will bite whoever edits this next ──────────────────────
 *
 * ⛔ **Do not build the per-file URI by string concatenation.**
 * `MongoMemoryReplSet.getUri()` already returns a complete URI *including* a
 * database *and* a query string: `mongodb://<hosts>/<generatedDb>?replicaSet=<name>`.
 * Appending a db name produces `?replicaSet=<name><dbName>` — a corrupted
 * replica-set name — and every DB-touching file then dies on a ~30s
 * server-selection timeout. Isolation goes through mongoose's `dbName`
 * **connect option**, which is applied over whatever database the URI names.
 * `db.smoke.test.ts` asserts `mongoose.connection.name === getTestDbName()` so a
 * regression here costs one failing test instead of 46 timeouts.
 *
 * ⚠ **Isolation is now per-database, not per-server.** Files share one mongod.
 * The db name carries a random suffix precisely so two files can never collide
 * and cross-wipe each other through `afterEach`'s deleteMany.
 */

/** Monotonic within a worker; part of the db name alongside pid + randomness. */
let counter = 0;
let currentDbName: string | null = null;

const resolveMongoUri = (): string => {
  // `inject()` is the contract. It throws if globalSetup did not run (e.g. a
  // stray direct vitest invocation), so fall back to the env channel and only
  // then give up with a message that names the cause.
  let uri: string | undefined;
  try {
    uri = inject('mongoUri');
  } catch {
    uri = undefined;
  }
  uri = uri || process.env.STRIVE_TEST_MONGO_URI;
  if (!uri) {
    throw new Error(
      'setupTestDb(): no shared Mongo URI. `test-globalSetup.ts` did not run — check ' +
        "vitest.config.ts still has `globalSetup: ['./test-globalSetup.ts']`.",
    );
  }
  return uri;
};

/**
 * `t_<file>_<pid>_<n>_<rand>` — Mongo db names are capped at 63 bytes and may
 * not contain `/\. "$*<>:|?`, hence the truncation + sanitising.
 */
const buildDbName = (): string => {
  const testPath = expect.getState().testPath ?? 'unknown';
  const base = path
    .basename(testPath)
    .replace(/\.test\.ts$/, '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .slice(0, 28);
  return `t_${base}_${process.pid}_${++counter}_${randomBytes(3).toString('hex')}`;
};

/**
 * The database this test file is isolated on. Exported for `db.smoke.test.ts`,
 * which pins `mongoose.connection.name` against it — see the ⛔ note above.
 */
export const getTestDbName = (): string => {
  if (!currentDbName) throw new Error('getTestDbName(): setupTestDb() has not connected yet');
  return currentDbName;
};

/**
 * Create each model's collection + indexes **outside** any transaction.
 *
 * Call this in a `beforeAll` in every file that writes through
 * `session.withTransaction`. MongoDB does permit implicit collection creation
 * inside a transaction, but it takes an exclusive lock, and a transaction's
 * lock-acquisition timeout is only 5ms
 * (`maxTransactionLockRequestTimeoutMillis`). The first write to a
 * not-yet-created collection inside a transaction therefore fails
 * intermittently with:
 *
 *   MongoServerError: Unable to acquire IX lock on '…Collection…' within 5ms
 *
 * which reads like a transaction bug and is actually a fixture-ordering bug.
 */
export const ensureCollections = async (...models: mongoose.Model<any>[]): Promise<void> => {
  for (const model of models) {
    try {
      await model.createCollection();
    } catch (err) {
      // 48 = NamespaceExists — another test file (or an earlier call) got there first.
      if ((err as { code?: number }).code !== 48) throw err;
    }
    await model.init();
  }
};

export const setupTestDb = () => {
  beforeAll(async () => {
    const uri = resolveMongoUri();
    currentDbName = buildDbName();
    await mongoose.connect(uri, {
      dbName: currentDbName,
      maxPoolSize: 5,
      minPoolSize: 1,
    });
  }, 60_000);

  afterEach(async () => {
    // Wipe every collection between tests but keep the connection + indexes.
    // deleteMany is faster than dropCollection here because it doesn't force
    // a re-syncIndexes round trip on the next insert.
    const collections = mongoose.connection.collections;
    for (const name of Object.keys(collections)) {
      await collections[name].deleteMany({});
    }
  });

  afterAll(async () => {
    // Drop this file's database so the shared server doesn't accumulate 46 of
    // them across a run. There is no server to stop — globalSetup owns it.
    // (Measured: dropping vs. leaving them makes no wall-clock difference, so
    // this is kept purely as hygiene.)
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
    currentDbName = null;
  });
};
