/**
 * Boot-file mount ORDER, asserted against the source text of `src/index.ts`.
 *
 * The bugs this file exists to prevent are all one-line reorders in the most
 * dangerous file in the repo, and every one of them is silent:
 *
 *   - the Stripe webhook's `express.raw` mount moved below the global
 *     `express.json()` → every real delivery 400s, entitlements freeze;
 *   - `requestId` moved below the rate limiter → 429s carry no
 *     `X-Request-ID`, so the one class of incident where correlation matters
 *     most is the one class you cannot correlate;
 *   - `errorHandler` no longer last, or the 404 catch-all after it → some
 *     errors escape to Express's default HTML stack page instead of the
 *     JSON envelope every client parses;
 *   - `Sentry.setupExpressErrorHandler(app)` added → every Zod 400 and every
 *     operational 4xx (INSUFFICIENT_CREDITS, EMAIL_NOT_VERIFIED) becomes a
 *     Sentry event and buries the real signal under quota;
 *   - `trust proxy` outside its production guard → clients can spoof
 *     `X-Forwarded-For` and pick their own rate-limit bucket;
 *   - `/swagger.json` / `/swagger` / `/dev` outside their non-production
 *     guard → the entire route table, body schemas and errorCode catalogue
 *     published to the internet as recon material;
 *   - `server.listen` outside `connectDB().then(...)` → traffic accepted
 *     before the boot reaper finishes, so the reaper can sweep a legitimate
 *     new job as a carcass.
 *
 * ⚠ **Why source text and not the real app.** `src/index.ts` cannot be
 * imported by a test: at module scope it calls `createServer`, `initSocketIO`,
 * `connectDB().then(server.listen)` and registers `SIGTERM` / `SIGINT` /
 * `uncaughtException` handlers. Importing it boots a server and installs
 * process handlers into the test worker. This is the plan's residual risk #1,
 * and the honest limit of this file: a reorder expressed differently enough
 * to slip these anchors (e.g. moving the webhook mount into a helper
 * function) is not caught. The anchors below cover the orderings that
 * actually break things. If `src/index.ts` is ever refactored for another
 * reason, extracting app construction into `src/app.ts` would let these
 * become assertions on the real app instead.
 *
 * Assertions are `indexOf` comparisons on short, distinctive anchors. A
 * reformat must NOT fail them; a reorder must.
 *
 * Run: yarn test index.mountOrder
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';

const SOURCE = readFileSync(path.resolve(__dirname, 'index.ts'), 'utf-8');

/**
 * Source with whole-line comments stripped. Needed for the "this must appear
 * NOWHERE" assertions: `index.ts` documents *why* it does not mount
 * `Sentry.setupExpressErrorHandler`, so a naive substring search finds the
 * explanation and fails on the file being correct.
 */
const CODE = SOURCE.split('\n')
  .filter((line) => {
    const t = line.trim();
    return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

/** Index of `needle`, asserting it exists at all. */
const at = (needle: string): number => {
  const idx = SOURCE.indexOf(needle);
  expect(idx, `anchor not found in src/index.ts: ${needle}`).toBeGreaterThanOrEqual(0);
  return idx;
};

/**
 * End of a top-level block opened at `from`: the first `}` sitting in column
 * zero. Cheap, and correct for this file because every top-level `if` /
 * `.then(` closes at column zero. Deliberately not a brace counter — one
 * would have to understand strings and comments to be right.
 */
const endOfTopLevelBlock = (from: number): number => {
  const idx = SOURCE.indexOf('\n}', from);
  expect(idx, 'could not find the end of the block starting at the given anchor').toBeGreaterThan(from);
  return idx;
};

const isInsideBlock = (blockAnchor: string, needle: string): boolean => {
  const start = at(blockAnchor);
  const end = endOfTopLevelBlock(start);
  const target = at(needle);
  return target > start && target < end;
};

describe('index.ts — body parsers', () => {
  test('the Stripe webhook is mounted with express.raw BEFORE the global express.json', () => {
    const webhookMount = at("app.post('/api/billing/stripe/webhook'");
    const jsonParser = at('app.use(express.json(');
    expect(webhookMount).toBeLessThan(jsonParser);
  });

  test('the webhook mount actually carries express.raw, not just any parser', () => {
    const line = SOURCE.slice(
      at("app.post('/api/billing/stripe/webhook'"),
      SOURCE.indexOf('\n', at("app.post('/api/billing/stripe/webhook'")),
    );
    expect(line).toContain('express.raw(');
    expect(line).toContain('stripeWebhookController');
  });

  test('the JSON body limit is declared as 1mb', () => {
    expect(SOURCE).toContain("express.json({ limit: '1mb' })");
  });
});

describe('index.ts — middleware order', () => {
  test('requestId is mounted BEFORE the global rate limiter, so 429s carry X-Request-ID', () => {
    expect(at('app.use(requestId)')).toBeLessThan(at('rateLimit({'));
  });

  test('the 404 catch-all is registered BEFORE errorHandler', () => {
    expect(at("const error = new Error('Not found');")).toBeLessThan(at('app.use(errorHandler)'));
  });

  test('errorHandler is the LAST app.use( in the file', () => {
    const uses = [...SOURCE.matchAll(/app\.use\(/g)].map((m) => m.index!);
    expect(uses.length).toBeGreaterThan(1);
    expect(Math.max(...uses)).toBe(at('app.use(errorHandler)'));
  });

  test('Sentry.setupExpressErrorHandler is mounted NOWHERE — errorHandler captures 5xx only', () => {
    // Checked against comment-stripped source: the file explains at length
    // why this integration is deliberately absent, and that explanation must
    // not be what makes the test pass or fail.
    expect(CODE).not.toContain('setupExpressErrorHandler');
    // Harness sanity for the strip: a line that IS code is still present.
    expect(CODE).toContain('app.use(errorHandler)');
  });
});

describe('index.ts — instrumentation import order', () => {
  test("import '@conf/sentry' precedes the http, mongoose and express imports", () => {
    const sentry = at("import '@conf/sentry';");
    expect(sentry).toBeLessThan(at("from 'http'"));
    expect(sentry).toBeLessThan(at("from 'express'"));
    expect(sentry).toBeLessThan(at("import mongoose from 'mongoose';"));
  });
});

describe('index.ts — environment guards', () => {
  test("app.set('trust proxy') is inside the ENVIRONMENT === 'production' guard", () => {
    expect(isInsideBlock("if (ENVIRONMENT === 'production') {", "app.set('trust proxy'")).toBe(true);
  });

  test('the global rate limiter is inside the ENVIRONMENT !== \'development\' guard', () => {
    expect(isInsideBlock("if (ENVIRONMENT !== 'development') {", 'rateLimit({')).toBe(true);
  });

  test('the limiter buckets authenticated callers as u:<userId> and anonymous as i:<ip>', () => {
    // Not reachable by a test (the limiter is declared inline on `app`), so
    // the key shape is pinned here as source text. A regression collapsing
    // every user into one `i:<ip>` bucket behind the ALB is a mass lockout.
    expect(SOURCE).toContain('`u:${decoded.id}`');
    expect(SOURCE).toContain('`i:${req.ip ?? \'anon\'}`');
  });

  test("/swagger.json, the swagger UI and /dev are all inside the ENVIRONMENT !== 'production' guard", () => {
    const guard = "if (ENVIRONMENT !== 'production') {";
    expect(isInsideBlock(guard, "app.get('/swagger.json'")).toBe(true);
    expect(isInsideBlock(guard, 'swaggerUi.serve')).toBe(true);
    expect(isInsideBlock(guard, "app.use('/dev', devRoutes)")).toBe(true);
  });

  test('harness sanity: the block-membership helper says NO for something outside the guard', () => {
    // Without this, an `isInsideBlock` that always returned true would make
    // every assertion above vacuous.
    expect(isInsideBlock("if (ENVIRONMENT !== 'production') {", 'app.use(errorHandler)')).toBe(false);
    expect(isInsideBlock("if (ENVIRONMENT === 'production') {", 'app.use(express.json(')).toBe(false);
  });
});

describe('index.ts — boot sequence', () => {
  test('server.listen is inside connectDB().then( — traffic is never accepted before the boot reaper finishes', () => {
    expect(isInsideBlock('connectDB().then(() => {', 'server.listen(PORT')).toBe(true);
  });

  test('startStuckJobWatchdog runs after server.listen, inside the same connectDB().then block', () => {
    // The watchdog must not race the boot reaper for the same `processing`
    // rows. Position-relative rather than scope-exact: this file reads text,
    // so "inside the listen callback" is approximated by "after listen and
    // inside the then-block".
    expect(isInsideBlock('connectDB().then(() => {', 'startStuckJobWatchdog();')).toBe(true);
    expect(at('server.listen(PORT')).toBeLessThan(at('startStuckJobWatchdog();'));
  });
});

describe('index.ts — the eight /api/* mounts', () => {
  const MOUNTS: [string, string][] = [
    ['/api/auth', 'authRoutes'],
    ['/api/billing', 'billingRoutes'],
    ['/api/course', 'courseRoutes'],
    ['/api/gamification', 'gamificationRoutes'],
    ['/api/recall', 'recallRoutes'],
    ['/api/product-kb', 'productKbRoutes'],
    ['/api/usage', 'usageRoutes'],
    ['/api/admin', 'adminRoutes'],
  ];

  test.each(MOUNTS)('%s is mounted with %s', (mountPath, router) => {
    expect(SOURCE).toContain(`app.use('${mountPath}', ${router});`);
  });

  test('all eight are mounted after express.json and before errorHandler', () => {
    for (const [mountPath, router] of MOUNTS) {
      const idx = at(`app.use('${mountPath}', ${router});`);
      expect(idx).toBeGreaterThan(at('app.use(express.json('));
      expect(idx).toBeLessThan(at('app.use(errorHandler)'));
    }
  });

  test('devRoutes is the ninth router and is NOT mounted under /api/', () => {
    expect(SOURCE).toContain("app.use('/dev', devRoutes);");
    expect(SOURCE).not.toContain("app.use('/api/dev'");
  });
});
