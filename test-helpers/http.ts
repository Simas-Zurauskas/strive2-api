import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import mongoose from 'mongoose';
import { generateAuthToken } from '@lib/auth';

/**
 * Real-HTTP plumbing for route-level tests: an ephemeral-port listener, a real
 * bearer token, and a thin `fetch` wrapper.
 *
 * This formalises the pattern `src/routes/authRoutes.marketing.test.ts` already
 * proves works — `app.listen(0, '127.0.0.1')` plus native `fetch`. No supertest:
 * a second idiom for the same job is worse than one idiom used everywhere.
 */

export interface TestServer {
  /** e.g. `http://127.0.0.1:52341` — no trailing slash. */
  base: string;
  /** Promise-based; MUST be awaited in `afterAll` or the port leaks. */
  close: () => Promise<void>;
}

export const startTestServer = async (app: Express): Promise<TestServer> => {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Express 5 / Node keep-alive sockets can hold `close` open past the
        // test file's lifetime; drop them explicitly.
        server.closeAllConnections?.();
      }),
  };
};

/**
 * Build an `Authorization` header from the REAL `@lib/auth` signer, never a
 * hand-forged JWT. A hand-forged token would let a test pass while `protect`'s
 * `{ algorithms: ['HS256'] }` pin, or its `tokenVersion` re-read, was broken.
 */
export const authHeaderFor = (user: {
  _id: mongoose.Types.ObjectId | string;
  tokenVersion?: number;
}): { Authorization: string } => ({
  Authorization: `Bearer ${generateAuthToken({
    id: String(user._id),
    tokenVersion: user.tokenVersion ?? 0,
  })}`,
});

export interface TestResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or `undefined` when the response was not JSON. */
  json: any;
  /** Raw response body. */
  text: string;
}

export interface TestRequestInit {
  headers?: Record<string, string>;
  /** Serialised as JSON with `content-type: application/json`. */
  body?: unknown;
  /** Sent verbatim — for raw-body routes. Wins over `body`. */
  rawBody?: string | Buffer;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const call = async (
  base: string,
  method: Method,
  path: string,
  init: TestRequestInit = {},
): Promise<TestResponse> => {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | Buffer | undefined;

  if (init.rawBody !== undefined) {
    body = init.rawBody;
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body as BodyInit | undefined,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  return { status: res.status, headers: res.headers, json: parsed, text };
};

/** `const http = req(base); await http.get('/api/admin/marketing/claims')`. */
export const req = (base: string) => ({
  get: (path: string, init?: TestRequestInit) => call(base, 'GET', path, init),
  post: (path: string, init?: TestRequestInit) => call(base, 'POST', path, init),
  put: (path: string, init?: TestRequestInit) => call(base, 'PUT', path, init),
  patch: (path: string, init?: TestRequestInit) => call(base, 'PATCH', path, init),
  del: (path: string, init?: TestRequestInit) => call(base, 'DELETE', path, init),
});
