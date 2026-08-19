/**
 * The global PDF render gate.
 *
 * A per-user rate limit and a global concurrency cap are not substitutes:
 * ten users each inside their own hourly allowance can still arrive at
 * once, and a course render is seconds of synchronous, non-yielding CPU on
 * a single-instance process. These tests pin that the gate is GLOBAL —
 * i.e. that a second user is refused while a first is rendering.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { limitPdfConcurrency, _internalsForTests } from './pdfConcurrency';

const { active, sweepStaleEntries, MAX_CONCURRENT_RENDERS } = _internalsForTests;

interface Harness {
  req: Request;
  res: Response;
  next: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  handlers: Record<string, () => void>;
}

const harness = (userId: string | undefined, id: string): Harness => {
  const handlers: Record<string, () => void> = {};
  const status = vi.fn(function (this: Response) {
    return this;
  });
  const json = vi.fn(function (this: Response) {
    return this;
  });
  const set = vi.fn(function (this: Response) {
    return this;
  });
  const res = {
    status,
    json,
    set,
    on: (event: string, cb: () => void) => {
      handlers[event] = cb;
    },
  } as unknown as Response;
  const req = { userId, id, method: 'GET', originalUrl: '/api/course/x/pdf' } as unknown as Request;
  return { req, res, next: vi.fn(), status, json, set, handlers };
};

const run = (h: Harness) => limitPdfConcurrency(h.req, h.res, h.next as unknown as NextFunction);

beforeEach(() => active.clear());

describe('the cap is global, not per user', () => {
  test('a DIFFERENT user is refused once the cap is reached', () => {
    const held: Harness[] = [];
    for (let i = 0; i < MAX_CONCURRENT_RENDERS; i++) {
      const h = harness(`user-${i}`, `req-${i}`);
      run(h);
      expect(h.next).toHaveBeenCalled();
      held.push(h);
    }

    // A brand-new user, well inside any per-user allowance.
    const stranger = harness('someone-else', 'req-stranger');
    run(stranger);
    expect(stranger.next).not.toHaveBeenCalled();
    expect(stranger.status).toHaveBeenCalledWith(429);
    expect(stranger.set).toHaveBeenCalledWith('Retry-After', '30');
  });

  test('a slot frees on response finish and the next caller gets through', () => {
    const first = harness('a', 'r1');
    const second = harness('b', 'r2');
    const third = harness('c', 'r3');
    run(first);
    run(second);
    run(third);
    expect(third.status).toHaveBeenCalledWith(429);

    first.handlers.finish();

    const fourth = harness('d', 'r4');
    run(fourth);
    expect(fourth.next).toHaveBeenCalled();
  });

  test('a client disconnect frees the slot too', () => {
    const first = harness('a', 'r1');
    run(first);
    expect(active.size).toBe(1);
    first.handlers.close();
    expect(active.size).toBe(0);
  });

  test('releasing twice does not double-free someone else’s slot', () => {
    const first = harness('a', 'r1');
    run(first);
    first.handlers.close();
    first.handlers.finish();
    expect(active.size).toBe(0);

    const second = harness('b', 'r2');
    run(second);
    expect(active.size).toBe(1);
    first.handlers.close(); // late duplicate from the first request
    expect(active.size).toBe(1); // second is untouched
  });
});

describe('the key cannot be forged by the caller', () => {
  // `req.id` comes from an inbound `X-Request-ID` header
  // (`middleware/requestId.ts:25-27`). Keying the slot map on it let a
  // client repeat one value, overwrite its own entry every time, and walk
  // straight past the cap.
  test('repeating one X-Request-ID does NOT bypass the cap', () => {
    let admitted = 0;
    for (let i = 0; i < 8; i++) {
      const h = harness('attacker', 'same-id-every-time');
      run(h);
      if (h.next.mock.calls.length > 0) admitted++;
    }
    expect(admitted).toBe(MAX_CONCURRENT_RENDERS);
    expect(active.size).toBe(MAX_CONCURRENT_RENDERS);
  });

  test('one request finishing does not free everyone else’s slot', () => {
    const a = harness('u', 'same-id');
    const b = harness('u', 'same-id');
    run(a);
    run(b);
    expect(active.size).toBe(2);
    a.handlers.finish();
    // b is still rendering; only a's slot went back.
    expect(active.size).toBe(1);
  });
});

describe('safety', () => {
  test('an unauthenticated request is refused without consuming a slot', () => {
    const h = harness(undefined, 'r1');
    run(h);
    expect(h.status).toHaveBeenCalledWith(401);
    expect(active.size).toBe(0);
  });

  test('a render that never signals is swept, so the gate cannot wedge shut', () => {
    const h = harness('a', 'r1');
    run(h);
    expect(active.size).toBe(1);
    // Age the slot the middleware actually created — the key is a private
    // counter, so reach it through the map rather than guessing an id.
    const [slot, entry] = [...active.entries()][0];
    active.set(slot, { ...entry, startedAt: Date.now() - 6 * 60 * 1000 });
    sweepStaleEntries();
    expect(active.size).toBe(0);
  });
});
