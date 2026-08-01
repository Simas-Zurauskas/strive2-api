/**
 * Self-test for the real-HTTP harness (`test-helpers/app.ts` + `http.ts`),
 * mirroring what `db.smoke.test.ts` does for the Mongo harness.
 *
 * The bug this prevents is one level up from any single route: **a harness
 * that silently reports green.** Phases 5-11 assert things like "this route
 * 401s without a bearer" and "a malformed id is a 400, not a 500". Every one
 * of those assertions is worthless if `errorHandler` was never actually last,
 * if the 404 catch-all was never mounted, or if `close()` leaks the port and
 * the next file's requests land on a stale server. Those failures do not look
 * like failures — they look like passes.
 *
 * Some tests here deliberately drive error paths, so the `request:error` lines
 * in this file's output are expected, not a symptom.
 *
 * Run: yarn test test-helpers
 */

import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp } from './app';
import { startTestServer, authHeaderFor, req, type TestServer } from './http';
import { AppError } from '@middleware/errorMiddleware';
import { decodeAuthToken } from '@lib/auth';
import mongoose from 'mongoose';

const probe = express.Router();
probe.get('/ok', (_q, res) => {
  res.status(200).json({ data: 'ok' });
});
probe.post('/echo', (q, res) => {
  res.status(200).json({ received: q.body });
});
probe.get('/boom', () => {
  throw new Error('deliberate explosion');
});
probe.get('/app-error', () => {
  throw new AppError('not enough', {
    statusCode: 402,
    errorCode: 'INSUFFICIENT_CREDITS',
    meta: { need: 7, have: 2 },
  });
});

let rawBodyType: string | null = null;
const rawHandler = (q: express.Request, res: express.Response) => {
  rawBodyType = Buffer.isBuffer(q.body) ? 'buffer' : typeof q.body;
  res.status(200).json({ ok: true });
};

let server: TestServer;
let http: ReturnType<typeof req>;

beforeAll(async () => {
  const app = makeTestApp({
    mount: { '/probe': probe },
    raw: [{ path: '/raw-hook', handler: rawHandler }],
  });
  server = await startTestServer(app);
  http = req(server.base);
});

afterAll(async () => {
  await server.close();
});

describe('makeTestApp wiring', () => {
  test('an unknown path produces the 404 error ENVELOPE — not an Express HTML page', async () => {
    const res = await http.get('/definitely-not-a-route');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.json).toMatchObject({ message: 'Not found' });
    expect(res.json.requestId).toEqual(expect.any(String));
    // Harness sanity in the opposite direction: a route that DOES exist must
    // not also 404, or this file would pass with no app mounted at all.
    expect((await http.get('/probe/ok')).status).toBe(200);
  });

  test('X-Request-ID is on every response, including the 404', async () => {
    const ok = await http.get('/probe/ok');
    const missing = await http.get('/nope');

    expect(ok.headers.get('x-request-id')).toBeTruthy();
    expect(missing.headers.get('x-request-id')).toBeTruthy();
    expect(ok.headers.get('x-request-id')).not.toBe(missing.headers.get('x-request-id'));
  });

  test('the error body requestId EQUALS the X-Request-ID response header', async () => {
    // The correlation contract: a user quoting the id from a bug report must
    // land on the same log line an operator greps for.
    const res = await http.get('/nope');
    expect(res.json.requestId).toBe(res.headers.get('x-request-id'));
  });

  test('a thrown error reaches errorHandler as a 500 envelope — deliberate failure path', async () => {
    const res = await http.get('/probe/boom');

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.json).toMatchObject({ message: 'deliberate explosion' });
    expect(res.json.requestId).toEqual(expect.any(String));
    // Express's default handler would return text/html with a stack trace.
    expect(res.text).not.toContain('<pre>');
  });

  test('AppError statusCode + errorCode + meta survive the trip over the wire', async () => {
    const res = await http.get('/probe/app-error');

    expect(res.status).toBe(402);
    expect(res.json).toMatchObject({
      message: 'not enough',
      errorCode: 'INSUFFICIENT_CREDITS',
      meta: { need: 7, have: 2 },
    });
  });

  test('express.json parses a posted body for the mounted router', async () => {
    const res = await http.post('/probe/echo', { body: { hello: 'world', n: 3 } });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: { hello: 'world', n: 3 } });
  });

  test('a `raw` mount receives an untouched Buffer — the Stripe-webhook requirement', async () => {
    rawBodyType = null;
    const res = await http.post('/raw-hook', { rawBody: '{"id":"evt_1"}' });

    expect(res.status).toBe(200);
    // If this ever reads 'object', express.json ran first and the signature
    // check in production would be verifying re-serialised bytes.
    expect(rawBodyType).toBe('buffer');
  });
});

describe('startTestServer lifecycle', () => {
  test('close() actually releases the port — a later request is refused', async () => {
    const throwaway = await startTestServer(makeTestApp({ mount: { '/probe': probe } }));
    expect((await req(throwaway.base).get('/probe/ok')).status).toBe(200);

    await throwaway.close();

    await expect(fetch(`${throwaway.base}/probe/ok`)).rejects.toThrow();
  });
});

describe('authHeaderFor', () => {
  test('mints a token the REAL decodeAuthToken accepts, carrying id + tokenVersion', () => {
    const _id = new mongoose.Types.ObjectId();
    const header = authHeaderFor({ _id, tokenVersion: 4 });

    expect(header.Authorization.startsWith('Bearer ')).toBe(true);
    const decoded = decodeAuthToken(header.Authorization.slice(7));
    expect(decoded?.id).toBe(String(_id));
    expect(decoded?.tokenVersion).toBe(4);
    // And the inverse, so this can't pass against a decoder that accepts anything.
    expect(decodeAuthToken('not.a.token')).toBeUndefined();
  });
});
