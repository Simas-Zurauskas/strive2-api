/**
 * Types the value `test-globalSetup.ts` publishes via `project.provide()` so
 * `inject('mongoUri')` type-checks under `yarn tsc`. Kept beside its only
 * consumer (`test-helpers/db.ts`) rather than in `src/types/`, which is
 * production surface.
 */

declare module 'vitest' {
  interface ProvidedContext {
    /** URI of the single shared `MongoMemoryReplSet` booted for the whole run. */
    mongoUri: string;
  }
}

export {};
