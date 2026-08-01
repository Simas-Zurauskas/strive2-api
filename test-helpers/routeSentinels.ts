import type { Request, Response } from 'express';

/**
 * Sentinel controllers for route-wiring tests.
 *
 * The bug class this prevents is not in the code under test — it is in the
 * *test*: a wiring file that expects a request to PASS its gate, and lets the
 * real controller run, will fire an LLM call, an S3 upload, a Stripe request,
 * or a bulk mail send. That test is slow, flaky, network-dependent, and
 * occasionally expensive. Replace the controller module with these instead:
 * every export answers `204` and records that it was reached, so
 * "the gate let this through" and "the gate blocked this" are both assertions
 * on a real HTTP status with no side effects behind them.
 *
 * Usage — the `vi.mock` factory must be above the router import, because the
 * router captures its controller references at module load:
 *
 *   const log = vi.hoisted(() => ({ hits: [] as string[] }));
 *   vi.mock('@controlers/course', async () => {
 *     const { sentinelControllers } = await import('../../test-helpers/routeSentinels');
 *     return sentinelControllers(log, ['createCourseController', …]);
 *   });
 *
 * Listing the names explicitly is deliberate. A controller added to the
 * router but not to the list arrives as `undefined` and Express throws
 * `Route.post() requires a callback function` at import — loud, immediate,
 * and pointing at the file that needs a new case.
 */

export interface SentinelLog {
  /** Controller export names reached, in order, since the last reset. */
  hits: string[];
}

export const sentinelControllers = (
  log: SentinelLog,
  names: readonly string[],
): Record<string, (req: Request, res: Response) => void> =>
  Object.fromEntries(
    names.map((name) => [
      name,
      (_req: Request, res: Response) => {
        log.hits.push(name);
        res.status(204).end();
      },
    ]),
  );
