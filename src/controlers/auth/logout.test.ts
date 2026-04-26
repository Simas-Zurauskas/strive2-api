/**
 * Tests for `logoutController`. The contract: `$inc tokenVersion` so any
 * pre-existing JWT becomes invalid on the next protected request.
 *
 * Run: yarn test logout
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { setupTestDb } from '../../../test-helpers/db';
import { makeUser, UserModel } from '../../../test-helpers/factories';
import { logoutController } from '@controlers/auth/logout';

setupTestDb();

const buildReqRes = (params: { userId?: string }) => {
  const req = { userId: params.userId } as unknown as Request;
  const status = vi.fn(function (this: Response, _code: number) {
    return this;
  });
  const json = vi.fn(function (this: Response, _body: unknown) {
    return this;
  });
  const res = { status, json } as unknown as Response;
  return { req, res, status, json };
};

const callLogout = async (req: Request, res: Response) => {
  return new Promise<void>((resolve, reject) => {
    Promise.resolve(logoutController(req, res, ((err?: unknown) => {
      if (err) reject(err);
      else resolve();
    }))).then(() => resolve(), reject);
  });
};

describe('logoutController', () => {
  test('happy path: increments tokenVersion + responds 200', async () => {
    const user = await makeUser();
    expect(user.tokenVersion).toBe(0);

    const { req, res, status, json } = buildReqRes({ userId: user._id.toString() });
    await callLogout(req, res);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.tokenVersion).toBe(1);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ data: { message: 'Logged out' } });
  });

  test('two consecutive logouts increment tokenVersion twice (idempotent in effect)', async () => {
    const user = await makeUser();

    const r1 = buildReqRes({ userId: user._id.toString() });
    await callLogout(r1.req, r1.res);
    const r2 = buildReqRes({ userId: user._id.toString() });
    await callLogout(r2.req, r2.res);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.tokenVersion).toBe(2);
    expect(r2.status).toHaveBeenCalledWith(200);
  });

  test('user already deleted (race with delete-account): still returns 200, no throw', async () => {
    const user = await makeUser();
    await UserModel.deleteOne({ _id: user._id });

    const { req, res, status } = buildReqRes({ userId: user._id.toString() });
    await callLogout(req, res); // should not throw
    expect(status).toHaveBeenCalledWith(200);
  });

  test('concurrent logouts on same user: $inc is atomic, ends at +N', async () => {
    const user = await makeUser();
    const calls = Array.from({ length: 5 }, () => {
      const { req, res } = buildReqRes({ userId: user._id.toString() });
      return callLogout(req, res);
    });
    await Promise.all(calls);

    const after = await UserModel.findById(user._id).lean();
    expect(after?.tokenVersion).toBe(5);
  });
});
