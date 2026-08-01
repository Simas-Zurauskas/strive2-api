import { vi } from 'vitest';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Build a minimal Request/Response/NextFunction trio for unit-testing
 * Express controllers in isolation. Returns the captured `status` + `json`
 * + `send` mocks so tests can assert on them.
 *
 * ── When a LOCAL builder is the right answer ──────────────────────────────
 *
 * Four files deliberately keep their own: `authMiddleware.test.ts` (takes an
 * `authHeader`, returns `next`), `errorMiddleware.test.ts` (needs
 * `preStatus`/`originalUrl`/`method`/`id`), `stripeWebhook.test.ts` (needs a raw
 * `Buffer` body + a `stripe-signature` header + `res.send`), and
 * `requireCredits.test.ts` (an empty `res`). Those are **specialisations with
 * three incompatible return shapes**, not copies. Folding them in would need a
 * ~10-option builder — a worse artifact than four focused ten-line functions.
 *
 * So: a fifth *specialisation*, when the middleware under test needs `req`/`res`
 * surface no other call site needs, is fine. A fifth *copy of this exact shape*
 * is not — import this instead. And when the thing under test is a whole
 * request path rather than one function, reach for `test-helpers/app.ts` +
 * `test-helpers/http.ts` and drive it over a real socket.
 */
export interface MockReqRes {
  req: Request;
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
}

export const buildReqRes = (params: {
  body?: unknown;
  userId?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  /** Parsed query string. Public link-driven routes (e.g. the marketing
   *  unsubscribe) carry their token here rather than in the body. */
  query?: Record<string, unknown>;
} = {}): MockReqRes => {
  // Express initialises `res.statusCode` to 200 and `res.status(n)` assigns it.
  // Mirroring that is free Express fidelity — `errorMiddleware`'s precedence
  // rule reads `res.statusCode`, so a mock that leaves it `undefined` cannot
  // represent "the controller already set a status". No existing call site
  // reads it, so this changes no behaviour today.
  const status = vi.fn(function (this: Response, code: number) {
    this.statusCode = code;
    return this;
  });
  const json = vi.fn(function (this: Response, _body: unknown) {
    return this;
  });
  const send = vi.fn(function (this: Response, _body: unknown) {
    return this;
  });
  const redirect = vi.fn(function (this: Response, ..._args: unknown[]) {
    return undefined;
  });

  const headers = params.headers ?? {};

  const res = {
    statusCode: 200,
    status,
    json,
    send,
    redirect,
    // No-op surface so middleware that touches these doesn't throw on a mock.
    setHeader: vi.fn(function (this: Response) {
      return this;
    }),
    get: vi.fn(() => undefined),
    on: vi.fn(function (this: Response) {
      return this;
    }),
  } as unknown as Response;

  const req = {
    body: params.body ?? {},
    userId: params.userId,
    headers,
    params: params.params ?? {},
    query: params.query ?? {},
    // `errorMiddleware` reads `req.get('User-Agent')`; case-insensitive like
    // Express's own implementation.
    get: (name: string) =>
      headers[name] ??
      headers[name.toLowerCase()] ??
      Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1],
  } as unknown as Request;

  return { req, res, status, json, send, redirect };
};

/**
 * Invoke an asyncHandler-wrapped controller. Resolves on next() (which
 * asyncHandler calls on success), rejects with the thrown error otherwise.
 */
export const invokeController = (
  handler: RequestHandler,
  req: Request,
  res: Response,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const next = ((err?: unknown) => {
      if (err) reject(err);
      else resolve();
    }) as NextFunction;
    Promise.resolve(handler(req, res, next)).then(() => resolve()).catch(reject);
  });
};
