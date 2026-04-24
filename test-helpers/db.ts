import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * Spin up an in-memory Mongo and connect mongoose to it for the lifetime of
 * a single test file. Each test starts with empty collections (afterEach
 * drops everything, leaving the schemas/indexes intact via syncIndexes).
 *
 * Usage at the top of any test file that touches a model:
 *
 *   import { setupTestDb } from '../../test-helpers/db';
 *   setupTestDb();
 *
 * The helper registers vitest hooks (beforeAll / afterEach / afterAll) so
 * call sites stay one line. MongoMemoryServer.create() downloads the Mongo
 * binary on first run (~200 MB into ~/.cache/mongodb-binaries); subsequent
 * runs reuse it.
 */
let memServer: MongoMemoryServer | null = null;

export const setupTestDb = () => {
  beforeAll(async () => {
    // Bump the mongod launch timeout — first cold start (or first run after
    // a node version bump) may need longer than the 10s default while the
    // binary spins up.
    memServer = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    const uri = memServer.getUri();
    await mongoose.connect(uri, { maxPoolSize: 5, minPoolSize: 1 });
  }, 120_000);

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
    await mongoose.disconnect();
    if (memServer) {
      await memServer.stop();
      memServer = null;
    }
  });
};
