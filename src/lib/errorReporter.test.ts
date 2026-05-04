/**
 * Unit tests for the canonical Sentry capture wrapper. These pin the
 * contract every callsite in the codebase relies on:
 *   - 4xx operational errors are dropped (Zod, AppError 4xx, our typed
 *     credit errors), 5xx and stackless throws still flow through
 *   - userId / plan / jobId tags are auto-attached from the active
 *     `usageContext` scope
 *   - caller-supplied tags / extra / level / fingerprint are merged on top
 *   - SDK failures inside the wrapper never leak to callers
 *
 * Run: yarn test errorReporter
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ZodError, z } from 'zod';
import { runWithUsageContext } from '@lib/usageContext';

// Minimal stand-in for Sentry's `Scope` — we capture the calls each
// captureError / captureWarning makes on it so assertions can read the
// shape directly. The real SDK scope has many other methods, but the
// wrapper only uses these.
class FakeScope {
  user: { id?: string } | null = null;
  tags: Record<string, unknown> = {};
  extras: Record<string, unknown> = {};
  level: string | undefined;
  fingerprint: string[] | undefined;

  setUser(u: { id?: string } | null) {
    this.user = u;
  }
  setTag(k: string, v: unknown) {
    this.tags[k] = v;
  }
  setExtra(k: string, v: unknown) {
    this.extras[k] = v;
  }
  setLevel(l: string) {
    this.level = l;
  }
  setFingerprint(f: string[]) {
    this.fingerprint = f;
  }
}

const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
let lastScope: FakeScope | null = null;

vi.mock('@sentry/node', () => ({
  withScope: (fn: (scope: FakeScope) => void) => {
    const scope = new FakeScope();
    lastScope = scope;
    fn(scope);
  },
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
  addBreadcrumb: vi.fn(),
  getCurrentScope: () => new FakeScope(),
}));

import {
  captureError,
  captureWarning,
  isOperationalClientError,
} from '@lib/errorReporter';

beforeEach(() => {
  vi.clearAllMocks();
  lastScope = null;
});

describe('isOperationalClientError', () => {
  test('ZodError is operational', () => {
    let zodErr: ZodError | undefined;
    try {
      z.object({ x: z.string() }).parse({ x: 1 });
    } catch (e) {
      zodErr = e as ZodError;
    }
    expect(isOperationalClientError(zodErr)).toBe(true);
  });

  test('400 / 402 / 409 / 429 → operational', () => {
    expect(isOperationalClientError({ statusCode: 400 })).toBe(true);
    expect(isOperationalClientError({ statusCode: 402 })).toBe(true);
    expect(isOperationalClientError({ statusCode: 409 })).toBe(true);
    expect(isOperationalClientError({ statusCode: 429 })).toBe(true);
  });

  test('500 / 502 / 503 → NOT operational', () => {
    expect(isOperationalClientError({ statusCode: 500 })).toBe(false);
    expect(isOperationalClientError({ statusCode: 502 })).toBe(false);
    expect(isOperationalClientError({ statusCode: 503 })).toBe(false);
  });

  test('plain Error / unknown shape → NOT operational (default to capture)', () => {
    expect(isOperationalClientError(new Error('kaboom'))).toBe(false);
    expect(isOperationalClientError('a string')).toBe(false);
    expect(isOperationalClientError(null)).toBe(false);
  });
});

describe('captureError', () => {
  test('4xx operational error is dropped — captureException not called', () => {
    captureError({ statusCode: 402, message: 'Insufficient credits' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test('Zod validation error is dropped', () => {
    let zodErr: ZodError | undefined;
    try {
      z.object({ x: z.string() }).parse({ x: 1 });
    } catch (e) {
      zodErr = e as ZodError;
    }
    captureError(zodErr);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test('5xx error flows through with caller tags + extras + fingerprint', () => {
    const err = Object.assign(new Error('kaboom'), { statusCode: 500 });
    captureError(err, {
      tags: { area: 'test', http_status: 500 },
      extra: { foo: 'bar' },
      fingerprint: ['test', 'kaboom'],
    });
    expect(captureExceptionMock).toHaveBeenCalledOnce();
    expect(captureExceptionMock).toHaveBeenCalledWith(err);
    expect(lastScope?.tags).toMatchObject({ area: 'test', http_status: 500 });
    expect(lastScope?.extras).toMatchObject({ foo: 'bar' });
    expect(lastScope?.fingerprint).toEqual(['test', 'kaboom']);
    expect(lastScope?.level).toBe('error');
  });

  test('stackless throw (no statusCode) flows through — defensive default', () => {
    captureError(new Error('whoops'));
    expect(captureExceptionMock).toHaveBeenCalledOnce();
  });

  test('auto-attaches userId / plan / jobId from active usageContext', async () => {
    const err = new Error('deep failure');
    await runWithUsageContext({
      ctx: {
        userId: 'user-42',
        source: 'job',
        jobId: 'job-9',
        courseId: 'course-3',
        plan: 'pro',
        subscriptionStatus: 'active',
        moduleIndex: 1,
        lessonIndex: 2,
      },
      fn: () => {
        captureError(err);
      },
    });
    expect(lastScope?.user).toEqual({ id: 'user-42' });
    expect(lastScope?.tags).toMatchObject({
      source: 'job',
      job_id: 'job-9',
      course_id: 'course-3',
      plan: 'pro',
      subscription_status: 'active',
    });
    expect(lastScope?.extras).toMatchObject({ moduleIndex: 1, lessonIndex: 2 });
  });

  test('caller tags override usageContext tags on the same scope', async () => {
    const err = new Error('kaboom');
    await runWithUsageContext({
      ctx: { userId: 'u', source: 'request', plan: 'free' },
      fn: () => {
        captureError(err, { tags: { plan: 'pro' } });
      },
    });
    // Plan is set first by usage context, then re-set by caller tags —
    // the caller wins.
    expect(lastScope?.tags.plan).toBe('pro');
  });

  test('explicit `level` option overrides default error level', () => {
    captureError(new Error('fatal one'), { level: 'fatal' });
    expect(lastScope?.level).toBe('fatal');
  });

  test('SDK failure inside withScope never throws to caller', () => {
    captureExceptionMock.mockImplementationOnce(() => {
      throw new Error('Sentry transport down');
    });
    expect(() => captureError(new Error('whoops'))).not.toThrow();
  });
});

describe('captureWarning', () => {
  test('records a message at warning level by default', () => {
    captureWarning('something off', { tags: { source: 'unit' } });
    expect(captureMessageMock).toHaveBeenCalledOnce();
    expect(captureMessageMock).toHaveBeenCalledWith('something off');
    expect(lastScope?.level).toBe('warning');
    expect(lastScope?.tags.source).toBe('unit');
  });

  test('level: info downgrades severity', () => {
    captureWarning('info-only signal', { level: 'info' });
    expect(lastScope?.level).toBe('info');
  });

  test('fingerprint collapses repeat warnings', () => {
    captureWarning('repeated', { fingerprint: ['fp', 'one'] });
    expect(lastScope?.fingerprint).toEqual(['fp', 'one']);
  });
});
