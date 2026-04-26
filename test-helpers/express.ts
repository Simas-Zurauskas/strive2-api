import { vi } from 'vitest';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Build a minimal Request/Response/NextFunction trio for unit-testing
 * Express controllers in isolation. Returns the captured `status` + `json`
 * + `send` mocks so tests can assert on them.
 */
export interface MockReqRes {
  req: Request;
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

export const buildReqRes = (params: {
  body?: unknown;
  userId?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
} = {}): MockReqRes => {
  const status = vi.fn(function (this: Response, _code: number) {
    return this;
  });
  const json = vi.fn(function (this: Response, _body: unknown) {
    return this;
  });
  const send = vi.fn(function (this: Response, _body: unknown) {
    return this;
  });

  const res = { status, json, send } as unknown as Response;
  const req = {
    body: params.body ?? {},
    userId: params.userId,
    headers: params.headers ?? {},
    params: params.params ?? {},
  } as unknown as Request;

  return { req, res, status, json, send };
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
