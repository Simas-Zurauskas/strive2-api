/**
 * AsyncLocalStorage that carries "who is this paid action for?" through the
 * whole async call chain, so deeply-nested LLM / image / search hooks can
 * attribute cost back to a user without every function signature having to
 * thread a `userId` parameter (and therefore breaking the single-param rule).
 *
 * Wiring: the Express request-context middleware (`middleware/usageContext.ts`)
 * runs after `protect`, reading `req.userId` and entering the ALS scope; the
 * job runner (`services/jobRunner.ts`) enters the scope around `executeJob`.
 * Outside those two entry points — boot-time reapers, tests, standalone
 * scripts — `getUsageContext()` returns undefined and `recordUsage` becomes
 * a no-op. That's deliberate: an untagged row is worse than no row.
 *
 * Propagation is automatic across `await`, `Promise.all`, timers, and
 * LangGraph's engine because AsyncLocalStorage hooks into libuv's async_hooks.
 * The one failure mode is manual `setImmediate(cb)` or raw EventEmitter
 * callbacks that fire after the store has exited — those call sites need
 * `als.run(ctx, cb)` explicitly. None of the paid-action integration points
 * use that shape.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Spend accumulator
 * ──────────────────────────────────────────────────────────────────────
 * Every scope carries a mutable `spendMicroCents` counter. Each
 * `recordUsage(...)` call increments it with the real provider cost.
 * At job completion the job runner reads the running total and debits
 * the user's credit balance accordingly (see `creditService.debitActualSpend`).
 *
 * The counter is a plain object (not a primitive) so references stay live
 * across AsyncLocalStorage propagation — a primitive would be copied into
 * closures and updates wouldn't reach the reader. The `runWithUsageContext`
 * wrapper creates a fresh counter per scope; callers never instantiate
 * one themselves.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface UsageContext {
  userId: string;
  /** Lets reports distinguish costs incurred inline in a request vs during a background job. */
  source: 'request' | 'job';
  /** When in a job path: the job row's id, so rows can be filtered per-job. */
  jobId?: string;
  /** Course the work attributes to, when known. */
  courseId?: string;
  /** Module / lesson indices for lesson-generation jobs. */
  moduleIndex?: number;
  lessonIndex?: number;
  /**
   * Mutable accumulator of real provider spend for this scope. Incremented
   * by `recordUsage` on every paid call; read at job end by
   * `debitActualSpend`. The object wrapper is required for cross-async
   * mutation visibility — don't swap it for a bare number.
   */
  spendMicroCents: { current: number };
}

/** Shape accepted by callers — they don't need to construct the accumulator. */
export type UsageContextInit = Omit<UsageContext, 'spendMicroCents'> & {
  spendMicroCents?: { current: number };
};

const als = new AsyncLocalStorage<UsageContext>();

export const runWithUsageContext = <T,>({
  ctx,
  fn,
}: {
  ctx: UsageContextInit;
  fn: () => Promise<T> | T;
}): Promise<T> | T => {
  const fullCtx: UsageContext = {
    ...ctx,
    // Fresh accumulator per scope. If one was passed (rare; only meaningful
    // for tests that want to inspect spend after the scope exits), honor it.
    spendMicroCents: ctx.spendMicroCents ?? { current: 0 },
  };
  return als.run(fullCtx, fn);
};

export const getUsageContext = (): UsageContext | undefined => als.getStore();
