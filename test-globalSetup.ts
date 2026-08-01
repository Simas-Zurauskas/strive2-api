/**
 * Vitest `globalSetup` — boots ONE transaction-capable mongod for the whole run.
 *
 * Two jobs, both load-bearing:
 *
 *  1. **Speed.** Before this file, `setupTestDb()` called `MongoMemoryServer.create()`
 *     per test file — 46 separate mongod boots at 1.5–6.5s each. Now every file
 *     connects to this one server and isolates on its own *database*.
 *
 *  2. **Transaction capability — the reason this is infrastructure, not an
 *     optimisation.** `lib/dbTransaction.ts` runs the real `session.withTransaction`
 *     only in production, and a standalone mongod cannot do transactions at all
 *     (`Transaction numbers are only allowed on a replica set member or mongos`).
 *     A **replica set** — even a single-member one, which Mongo ≥4.0 accepts — makes
 *     the production branch executable under test. That is what lets
 *     `creditService.transaction.test.ts` prove *"a debit is never written without
 *     its ledger row"*, an invariant the suite was previously architecturally
 *     incapable of checking. `test-helpers/db.smoke.test.ts` asserts the topology
 *     really is a replica set, so that proof cannot silently degrade.
 *
 * ⛔ **Never concatenate a database name onto `getUri()`.** It already returns a
 * complete URI *with* a database *and* a query string
 * (`mongodb://<hosts>/<generatedDb>?replicaSet=<name>`). Appending yields
 * `?replicaSet=<name><dbName>` — a corrupted replica-set name, which surfaces as
 * server-selection timeouts in all 46 DB-touching files at ~30s each. Per-file
 * isolation goes through mongoose's `dbName` **connect option**; see
 * `test-helpers/db.ts`.
 */

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

let replSet: MongoMemoryReplSet | null = null;

/**
 * NB: named `setup` + `teardown`, deliberately — **no default export.**
 * Vitest's loader (`loadGlobalSetupFile`) short-circuits on `m.default` and
 * then *ignores* a named `teardown` entirely. A default export plus a named
 * teardown therefore leaks the mongod: every run ends with
 * `close timed out after 10000ms … something prevents Vite server from
 * exiting` and a stray process. Keep both exports named.
 */
export async function setup(project: TestProject): Promise<void> {
  replSet = await MongoMemoryReplSet.create({
    // A single member is enough for transactions and starts far faster than a
    // three-node set — there is no replication behaviour under test here, only
    // the transaction capability a replica set unlocks.
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // First cold start (or the first run after a node bump) can exceed the
    // 10s default while the binary spins up.
    instanceOpts: [{ launchTimeout: 60_000 }],
  });

  const uri = replSet.getUri();

  // `inject('mongoUri')` is the documented contract and the primary channel.
  project.provide('mongoUri', uri);
  // Env is the belt: workers are spawned after globalSetup so mutation here
  // usually propagates, but that is not contractual. `db.ts` prefers inject()
  // and falls back to this; `db.smoke.test.ts` proves which path fired.
  process.env.STRIVE_TEST_MONGO_URI = uri;
}

export async function teardown(): Promise<void> {
  if (replSet) {
    await replSet.stop();
    replSet = null;
  }
}
