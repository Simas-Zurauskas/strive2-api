import mongoose, { ClientSession } from 'mongoose';
import { ENVIRONMENT } from '@conf/env';

/**
 * Wrap a sequence of writes in a Mongo transaction so they commit atomically.
 *
 * Why a wrapper instead of inlining `session.withTransaction(...)`:
 *   1. Mongo transactions require a replica set or mongos. Atlas always is
 *      one; mongodb-memory-server in our test suite is single-node and
 *      doesn't support them. Tests would fail on commit with
 *      `Transaction numbers are only allowed on a replica set member or
 *      mongos`. We bypass the transaction in test/dev so the LOGICAL
 *      ordering is exercised even when the storage layer can't enforce
 *      atomicity.
 *   2. Ergonomic: callers always pass `{ session }` to `Model.updateOne`
 *      etc. When session is null (test/dev), passing it is a harmless no-op
 *      to the driver.
 *
 * Production guarantees: when `ENVIRONMENT === 'production'` AND the Mongo
 * deployment supports transactions, the callback runs inside a real
 * transaction that commits atomically. Mid-transaction crash → partial
 * writes are rolled back. Concurrent writers either both commit (no
 * conflict) or one retries automatically (handled inside `withTransaction`).
 *
 * Dev/test contract: callbacks run sequentially without any wrapping
 * transaction. Crash mid-callback can leave partial state (same as today).
 *
 * Usage:
 *   await withCreditTransaction(async (session) => {
 *     await UserModel.updateOne(filter, update, { session });
 *     await CreditLedgerModel.create([{...}], { session });
 *   });
 *
 * Note: `Model.create([doc], { session })` returns an array; passing the doc
 * directly with a session option requires the array form.
 */
export const withCreditTransaction = async <T>(
  fn: (session: ClientSession | null) => Promise<T>,
): Promise<T> => {
  // Skip the real transaction in test/dev. We still execute the callback so
  // logic is exercised, just without atomicity at the storage layer.
  if (ENVIRONMENT !== 'production') {
    return fn(null);
  }

  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    let captured: unknown;
    await session.withTransaction(async () => {
      try {
        result = await fn(session);
      } catch (err) {
        captured = err;
        throw err; // surfaces to withTransaction so it aborts
      }
    });
    if (captured) throw captured;
    return result as T;
  } finally {
    await session.endSession();
  }
};
