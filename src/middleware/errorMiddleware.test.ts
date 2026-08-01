/**
 * Tests for the error middleware. Public-facing error shape — every API
 * client + the client UI's axios interceptor depends on the response body
 * shape (message / errorCode / meta / requestId / stack). Audit gap: this
 * file was untested even though it's the bottom of the call stack for every
 * thrown error in the API.
 *
 * Run: yarn test errorMiddleware
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { errorHandler, AppError, ERROR_CODES, type IError } from '@middleware/errorMiddleware';

const buildReqRes = ({
  preStatus,
  url = '/api/test',
  method = 'GET',
  userId,
  requestId,
}: {
  preStatus?: number;
  url?: string;
  method?: string;
  userId?: string;
  requestId?: string;
} = {}) => {
  const status = vi.fn();
  const json = vi.fn();
  const get = vi.fn().mockReturnValue('test-agent/1.0');
  const res = {
    statusCode: preStatus ?? 200,
    status: status.mockImplementation(function (this: Response, code: number) {
      (this as unknown as { statusCode: number }).statusCode = code;
      return this;
    }),
    json,
  } as unknown as Response;
  const req = {
    originalUrl: url,
    method,
    userId,
    id: requestId,
    get,
  } as unknown as Request;
  const next = vi.fn() as NextFunction;
  return { req, res, next, status, json };
};

describe('errorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('ZodError → 400 with first issue message; no errorCode/stack/requestId echoed', async () => {
    const schema = z.object({ name: z.string().min(3, 'name too short') });
    let zodErr: ZodError;
    try {
      schema.parse({ name: 'a' });
      throw new Error('schema should have failed');
    } catch (e) {
      zodErr = e as ZodError;
    }
    const { req, res, next, json } = buildReqRes();
    await errorHandler(zodErr as unknown as IError, req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ message: 'name too short' });
  });

  test('controller called res.status(401) before throw → status preserved', async () => {
    const { req, res, next, json } = buildReqRes({ preStatus: 401 });
    const err: IError = { message: 'Unauthorized' };
    await errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unauthorized' }),
    );
  });

  test('AppError with statusCode option → status used as fallback', async () => {
    const { req, res, json } = buildReqRes();
    const err = new AppError('Slow down', {
      errorCode: 'TOO_MANY_ACTIVE_JOBS',
      statusCode: 429,
      meta: { active: 3, limit: 1 },
    });
    await errorHandler(err as unknown as IError, req, res, vi.fn() as NextFunction);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Slow down',
        errorCode: 'TOO_MANY_ACTIVE_JOBS',
        meta: { active: 3, limit: 1 },
      }),
    );
  });

  test('AppError errorCode is echoed verbatim', async () => {
    const { req, res, json } = buildReqRes();
    const err = new AppError('You ran out', {
      errorCode: 'INSUFFICIENT_CREDITS',
      statusCode: 402,
      meta: { need: 1, have: 0 },
    });
    await errorHandler(err as unknown as IError, req, res, vi.fn() as NextFunction);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'INSUFFICIENT_CREDITS',
        meta: { need: 1, have: 0 },
      }),
    );
  });

  test('plain Error without statusCode and no preStatus → 500', async () => {
    const { req, res, json } = buildReqRes();
    const err: IError = { message: 'kaboom' };
    await errorHandler(err, req, res, vi.fn() as NextFunction);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'kaboom' }),
    );
  });

  test('requestId from req.id is echoed in response body', async () => {
    const { req, res, json } = buildReqRes({ requestId: 'req-abc-123' });
    const err: IError = { message: 'oops', statusCode: 400 };
    await errorHandler(err, req, res, vi.fn() as NextFunction);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-abc-123' }),
    );
  });

  test('missing req.id → requestId falls back to "-" (no crash)', async () => {
    const { req, res, json } = buildReqRes({ requestId: undefined });
    const err: IError = { message: 'oops', statusCode: 400 };
    await errorHandler(err, req, res, vi.fn() as NextFunction);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: '-' }),
    );
  });

  test('test environment → stack is included (production-only nulling)', async () => {
    // ENVIRONMENT in test-setup.ts is 'test', not 'production' — stack
    // should be present.
    const { req, res, json } = buildReqRes();
    const err: IError = { message: 'kaboom', statusCode: 500, stack: 'Error: kaboom\n  at … ' };
    await errorHandler(err, req, res, vi.fn() as NextFunction);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ stack: expect.stringContaining('kaboom') }),
    );
  });

  test('no errorCode on the error → omitted from response body (not null)', async () => {
    const { req, res, json } = buildReqRes();
    const err: IError = { message: 'plain', statusCode: 400 };
    await errorHandler(err, req, res, vi.fn() as NextFunction);
    const body = json.mock.calls[0][0];
    expect(body).not.toHaveProperty('errorCode');
  });

  test('no meta on the error → omitted from response body', async () => {
    const { req, res, json } = buildReqRes();
    const err = new AppError('bare', { errorCode: 'CUSTOM_ERROR', statusCode: 400 });
    await errorHandler(err as unknown as IError, req, res, vi.fn() as NextFunction);
    const body = json.mock.calls[0][0];
    expect(body).not.toHaveProperty('meta');
  });
});

describe('ERROR_CODES registry', () => {
  test('carries the course-from-documents codes', () => {
    for (const code of [
      'CONTENT_REJECTED',
      'UNSUPPORTED_FILE_TYPE',
      'DOCUMENT_LIMIT_EXCEEDED',
      'DOCUMENT_EXTRACTION_FAILED',
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});
