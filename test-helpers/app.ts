import express, { type Express, type Request, type RequestHandler, type Router } from 'express';
import { requestId } from '@middleware/requestId';
import { errorHandler } from '@middleware/errorMiddleware';

/**
 * Build an Express app that mirrors `src/index.ts`'s middleware ORDER, so a
 * test can drive a real router over a real socket instead of calling a
 * controller as a bare function with `userId` pre-set.
 *
 * The bug class this exists to prevent: a gate dropped, reordered, or applied
 * to the wrong side of a `router.use(protect)` line. None of that is visible
 * when the controller is invoked directly — the whole auth/validation chain is
 * wiring no such test executes.
 *
 * Order below, matching index.ts:
 *   raw-body routes (BEFORE the JSON parser — the Stripe webhook's requirement)
 *   → express.json({ limit: '1mb' })
 *   → requestId
 *   → `before` middleware
 *   → the router(s) at their PRODUCTION mount path
 *   → `after` handlers
 *   → the 404 catch-all
 *   → errorHandler, always last
 *
 * ⚠ **This is a reconstruction of `index.ts`, and reconstructions drift.**
 * Treat anything asserted through it as pinning *the router*, not *the app*.
 * The real app's mount order is a separate problem (Phase 7's source-order
 * assertions, or the optional `src/app.ts` extraction).
 */

export interface RawMount {
  /** Absolute path, e.g. '/api/billing/stripe/webhook'. */
  path: string;
  handler: RequestHandler;
  /** Content type express.raw() should claim. Defaults to Stripe's. */
  type?: string;
}

export interface TestAppOptions {
  /** Routers keyed by their production mount path, e.g. `{ '/api/admin': adminRoutes }`. */
  mount?: Record<string, Router | RequestHandler>;
  /** Middleware inserted after `requestId`, before the routers. */
  before?: RequestHandler[];
  /** Handlers appended after the routers, before the 404 catch-all. */
  after?: RequestHandler[];
  /**
   * Routes needing the untouched request bytes. Mounted with `express.raw()`
   * BEFORE `express.json()` — which is the only ordering that works, because
   * `express.json()` consumes and re-serialises the body and a signature check
   * over re-serialised bytes fails.
   */
  raw?: RawMount[];
  /**
   * Deliberately mount `raw` AFTER `express.json()`. This is the production
   * failure — every real Stripe delivery 400s and entitlements freeze — made
   * constructible so a test can pin it. Never true outside such a test.
   */
  rawAfterJson?: boolean;
}

const mountRaw = (app: Express, raw: RawMount[]): void => {
  for (const { path, handler, type } of raw) {
    app.post(path, express.raw({ type: type ?? 'application/json' }), handler);
  }
};

export const makeTestApp = (options: TestAppOptions = {}): Express => {
  const app = express();
  const raw = options.raw ?? [];

  if (!options.rawAfterJson) mountRaw(app, raw);

  app.use(express.json({ limit: '1mb' }));

  if (options.rawAfterJson) mountRaw(app, raw);

  app.use(requestId);

  for (const mw of options.before ?? []) app.use(mw);

  for (const [path, router] of Object.entries(options.mount ?? {})) {
    app.use(path, router);
  }

  for (const handler of options.after ?? []) app.use(handler);

  // index.ts's 404 catch-all: set the status, then hand a plain Error to the
  // error middleware so a missing route produces the same envelope as any
  // other failure rather than Express's HTML page.
  app.use((_req: Request, res, next) => {
    res.status(404);
    next(new Error('Not found'));
  });

  app.use(errorHandler);

  return app;
};
