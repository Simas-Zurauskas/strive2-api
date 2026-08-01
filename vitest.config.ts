import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    // `scripts/**/*` is dev-only tooling (debugOrchestrator) outside the
    // shipped api/src/. Its co-located tests still need to run; include
    // them here so vitest picks them up after the move from src/scripts/.
    include: ['src/**/*.test.ts', 'test-helpers/**/*.test.ts', 'scripts/**/*.test.ts'],
    // ONE shared, transaction-capable mongod for the whole run (replacing 46
    // per-file boots). It is also what makes `session.withTransaction` — and
    // therefore the money-path proof in creditService.transaction.test.ts —
    // executable at all: transactions need a replica set. See
    // test-globalSetup.ts and test-helpers/db.ts.
    globalSetup: ['./test-globalSetup.ts'],
    environment: 'node',
    reporters: ['default'],
    setupFiles: ['./test-setup.ts'],
    // DB-touching tests need more headroom than vitest's 5s default —
    // mongodb-memory-server's first start can take ~10s while it boots
    // the embedded mongod.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
