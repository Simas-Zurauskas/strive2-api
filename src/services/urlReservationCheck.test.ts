/**
 * Tests for the pre-fetch rights-reservation gate (robots.txt RFC 9309 +
 * TDM Reservation Protocol). Network is fully mocked: `globalThis.fetch`
 * and `dns/promises.lookup` are the only outside edges.
 *
 * The verdict split under test is the plan's A9, and getting it backwards
 * is the whole risk: **an absent robots.txt / 404 / missing tdmrep.json is
 * NOT a reservation and MUST allow**, while an explicit `Disallow` for our
 * token, a TDM reservation, or an *undecidable* answer (5xx, timeout,
 * malformed reservation document) blocks.
 *
 * Run: yarn test urlReservationCheck
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import {
  checkUrlReservation,
  clearReservationCacheForTest,
  RESERVATION_MAX_BYTES,
  STRIVE_FETCH_UA_TOKEN,
  STRIVE_FETCH_USER_AGENT,
} from './urlReservationCheck';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

// ── Mock plumbing ─────────────────────────────────────────

/**
 * Route factory — a fresh `Response` per call. Never reuse one instance:
 * response bodies are single-use streams and `clone()` tees them, which
 * deadlocks on a body larger than the internal queue.
 */
type Route = () => Response | Promise<Response>;

const res = (
  body: string,
  init: { status?: number; contentType?: string; location?: string } = {},
): Route => {
  const headers: Record<string, string> = {};
  if (init.contentType) headers['content-type'] = init.contentType;
  if (init.location) headers.location = init.location;
  return () => new Response(body, { status: init.status ?? 200, headers });
};

const NO_BODY_STATUSES = new Set([204, 301, 302, 303, 304, 307, 308]);

const empty = (status: number, location?: string): Route => () =>
  new Response(NO_BODY_STATUSES.has(status) ? null : '', {
    status,
    headers: location ? { location } : {},
  });

/**
 * Route the two well-known paths per host. Anything else asked for is a
 * test failure by construction — the gate must never fetch the article.
 */
const routes = (map: Record<string, Route>) => {
  fetchSpy.mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const hit = map[url];
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    return hit();
  });
};

const ROBOTS = 'https://example.com/robots.txt';
const TDM = 'https://example.com/.well-known/tdmrep.json';
const ARTICLE = 'https://example.com/articles/standard-error';

const allowAll = (extra: Record<string, Route> = {}) =>
  routes({ [ROBOTS]: empty(404), [TDM]: empty(404), ...extra });

beforeEach(() => {
  clearReservationCacheForTest();
  fetchSpy.mockReset();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── A9: no reservation ⇒ ALLOW ────────────────────────────

describe('checkUrlReservation — absent reservation allows (A9)', () => {
  test('robots.txt 404 + tdmrep.json 404 ⇒ allowed / no_reservation', async () => {
    allowAll();
    const verdict = await checkUrlReservation(ARTICLE);
    expect(verdict).toMatchObject({ allowed: true, signal: 'no_reservation' });
    expect(verdict.checkedAt).toBeInstanceOf(Date);
  });

  test('robots.txt 200 with rules that do not cover the path ⇒ allowed', async () => {
    routes({
      [ROBOTS]: res('User-agent: *\nDisallow: /private/\nDisallow: /admin\n', { contentType: 'text/plain' }),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true, signal: 'no_reservation' });
  });

  test('robots.txt 200 that is not robots-shaped at all parses to zero rules ⇒ allowed', async () => {
    // Soft-404 HTML at /robots.txt. RFC 9309 says unparseable lines are
    // ignored, so "no groups" is genuinely "no reservation".
    routes({ [ROBOTS]: res('<html><body>Not found</body></html>', { contentType: 'text/html' }), [TDM]: empty(404) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true, signal: 'no_reservation' });
  });

  test('an empty Disallow value is a no-op rule ⇒ allowed', async () => {
    routes({ [ROBOTS]: res('User-agent: *\nDisallow:\n', { contentType: 'text/plain' }), [TDM]: empty(404) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true });
  });

  test('robots 403/401 (403 is a 4xx ⇒ "unavailable" per RFC 9309) ⇒ allowed', async () => {
    routes({ [ROBOTS]: empty(403), [TDM]: empty(404) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true, signal: 'no_reservation' });
  });

  test('tdmrep.json present but reserving nothing (tdm-reservation 0) ⇒ allowed', async () => {
    routes({
      [ROBOTS]: empty(404),
      [TDM]: res(JSON.stringify([{ location: '/', 'tdm-reservation': 0 }]), { contentType: 'application/json' }),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true, signal: 'no_reservation' });
  });

  test('tdmrep.json empty array ⇒ allowed', async () => {
    routes({ [ROBOTS]: empty(404), [TDM]: res('[]', { contentType: 'application/json' }) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true });
  });

  test('a non-JSON soft-404 body at /.well-known/tdmrep.json is absence, not a malformed reservation ⇒ allowed', async () => {
    routes({
      [ROBOTS]: empty(404),
      [TDM]: res('<!doctype html><title>404</title>', { contentType: 'text/html' }),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true, signal: 'no_reservation' });
  });
});

// ── Explicit reservations ⇒ BLOCK ─────────────────────────

describe('checkUrlReservation — explicit reservations block', () => {
  test('Disallow: / under our own product token ⇒ blocked / robots_disallow', async () => {
    routes({
      [ROBOTS]: res(`User-agent: ${STRIVE_FETCH_UA_TOKEN}\nDisallow: /\n`, { contentType: 'text/plain' }),
      [TDM]: empty(404),
    });
    const verdict = await checkUrlReservation(ARTICLE);
    expect(verdict.allowed).toBe(false);
    expect(verdict.signal).toBe('robots_disallow');
    expect(verdict.reason).toBeTruthy();
  });

  test('Disallow under the wildcard group ⇒ blocked', async () => {
    routes({
      [ROBOTS]: res('User-agent: *\nDisallow: /articles/\n', { contentType: 'text/plain' }),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'robots_disallow' });
  });

  test('our token group WINS over the wildcard group (RFC 9309 group selection)', async () => {
    routes({
      [ROBOTS]: res(
        `User-agent: *\nDisallow: /\n\nUser-agent: ${STRIVE_FETCH_UA_TOKEN}\nAllow: /\n`,
        { contentType: 'text/plain' },
      ),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true });
  });

  test('product-token matching is exact, not substring — a "Fetch" group must not capture "StriveFetch"', async () => {
    // Wikipedia really does ship `User-agent: Fetch / Disallow: /`; a
    // naive includes() match would refuse every Wikipedia URL.
    routes({
      [ROBOTS]: res('User-agent: Fetch\nDisallow: /\n\nUser-agent: *\nDisallow: /w/\n', { contentType: 'text/plain' }),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true, signal: 'no_reservation' });
  });

  test('longest-match wins and Allow beats Disallow on an equal-length tie', async () => {
    routes({
      [ROBOTS]: res('User-agent: *\nDisallow: /articles/\nAllow: /articles/standard-error\n', {
        contentType: 'text/plain',
      }),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true });

    clearReservationCacheForTest();
    routes({
      [ROBOTS]: res('User-agent: *\nAllow: /articles/\nDisallow: /articles/\n', { contentType: 'text/plain' }),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true });
  });

  test('wildcard and $ end-anchor patterns are honoured', async () => {
    routes({
      [ROBOTS]: res('User-agent: *\nDisallow: /*/standard-error$\n', { contentType: 'text/plain' }),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'robots_disallow' });
  });

  test('tdmrep.json reservation over the whole site ⇒ blocked / tdm_reservation', async () => {
    routes({
      [ROBOTS]: empty(404),
      [TDM]: res(JSON.stringify([{ location: '/', 'tdm-reservation': 1, 'tdm-policy': 'https://example.com/p' }]), {
        contentType: 'application/json',
      }),
    });
    const verdict = await checkUrlReservation(ARTICLE);
    expect(verdict).toMatchObject({ allowed: false, signal: 'tdm_reservation' });
  });

  test('tdmrep longest-prefix match decides: /articles reserved, / open ⇒ blocked', async () => {
    routes({
      [ROBOTS]: empty(404),
      [TDM]: res(
        JSON.stringify([
          { location: '/', 'tdm-reservation': 0 },
          { location: 'articles/', 'tdm-reservation': 1 },
        ]),
        { contentType: 'application/json' },
      ),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'tdm_reservation' });
  });

  test('tdmrep longest-prefix match decides: another section reserved ⇒ allowed', async () => {
    routes({
      [ROBOTS]: empty(404),
      [TDM]: res(
        JSON.stringify([
          { location: '/', 'tdm-reservation': 0 },
          { location: '/news/', 'tdm-reservation': 1 },
        ]),
        { contentType: 'application/json' },
      ),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true, signal: 'no_reservation' });
  });

  test('robots is evaluated first — a robots Disallow blocks even with a permissive tdmrep', async () => {
    routes({
      [ROBOTS]: res('User-agent: *\nDisallow: /\n', { contentType: 'text/plain' }),
      [TDM]: res(JSON.stringify([{ location: '/', 'tdm-reservation': 0 }]), { contentType: 'application/json' }),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'robots_disallow' });
  });
});

// ── Undecidable ⇒ FAIL CLOSED ─────────────────────────────

describe('checkUrlReservation — undecidable answers fail closed (A9)', () => {
  test('robots.txt 500 ⇒ blocked / robots_unavailable', async () => {
    routes({ [ROBOTS]: empty(503), [TDM]: empty(404) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({
      allowed: false,
      signal: 'robots_unavailable',
    });
  });

  test('robots.txt 429 ⇒ blocked (RFC 9309 treats it as unreachable)', async () => {
    routes({ [ROBOTS]: empty(429), [TDM]: empty(404) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'robots_unavailable' });
  });

  test('robots.txt timeout ⇒ blocked', async () => {
    routes({
      [ROBOTS]: () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      },
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'robots_unavailable' });
  });

  test('robots.txt network error ⇒ blocked', async () => {
    routes({ [ROBOTS]: () => Promise.reject(new TypeError('fetch failed')), [TDM]: empty(404) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'robots_unavailable' });
  });

  test('a robots.txt bigger than the body cap ⇒ blocked (the governing group may be past the cut)', async () => {
    const huge = `# ${'x'.repeat(RESERVATION_MAX_BYTES + 1024)}\nUser-agent: *\nDisallow: /\n`;
    routes({ [ROBOTS]: res(huge, { contentType: 'text/plain' }), [TDM]: empty(404) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'robots_unavailable' });
  });

  test('tdmrep.json 500 ⇒ blocked / tdm_unavailable', async () => {
    routes({ [ROBOTS]: empty(404), [TDM]: empty(500) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'tdm_unavailable' });
  });

  test('tdmrep.json served as JSON but unparseable ⇒ blocked / tdm_malformed', async () => {
    routes({ [ROBOTS]: empty(404), [TDM]: res('{ not json at all', { contentType: 'application/json' }) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'tdm_malformed' });
  });

  test('tdmrep.json valid JSON with a wrong-shaped entry ⇒ blocked / tdm_malformed', async () => {
    routes({
      [ROBOTS]: empty(404),
      [TDM]: res(JSON.stringify([{ location: '/', 'tdm-reservation': 'yes' }]), { contentType: 'application/json' }),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'tdm_malformed' });
  });

  test('tdmrep.json JSON object instead of the required array ⇒ blocked / tdm_malformed', async () => {
    routes({
      [ROBOTS]: empty(404),
      [TDM]: res(JSON.stringify({ location: '/', 'tdm-reservation': 1 }), { contentType: 'application/json' }),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'tdm_malformed' });
  });
});

// ── SSRF posture ──────────────────────────────────────────

describe('checkUrlReservation — SSRF posture', () => {
  test('a non-https(s) or private-literal URL is refused without any fetch', async () => {
    for (const bad of ['file:///etc/passwd', 'http://localhost/x', 'http://127.0.0.1/x', 'http://10.1.2.3/x', 'not a url']) {
      clearReservationCacheForTest();
      await expect(checkUrlReservation(bad)).resolves.toMatchObject({ allowed: false, signal: 'unsafe_host' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a hostname that RESOLVES to a private address is refused without any fetch', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);
    allowAll();
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'unsafe_host' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a hostname resolving to IPv6 loopback / link-local / ULA is refused', async () => {
    for (const address of ['::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      clearReservationCacheForTest();
      lookupMock.mockResolvedValue([{ address, family: 6 }]);
      await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'unsafe_host' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a DNS failure fails closed', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a redirect to an internal host is refused — the host is re-validated on every hop', async () => {
    lookupMock.mockImplementation(async (host: string) =>
      host === 'example.com' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '169.254.169.254', family: 4 }],
    );
    routes({
      [ROBOTS]: empty(301, 'http://metadata.internal/latest/meta-data/'),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'unsafe_host' });
    // The redirect target was never dereferenced.
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).not.toContain('http://metadata.internal/latest/meta-data/');
  });

  test('a redirect to a private IP literal is refused', async () => {
    routes({ [ROBOTS]: empty(302, 'https://192.168.1.1/robots.txt'), [TDM]: empty(404) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'unsafe_host' });
  });

  test('redirects are followed up to the cap, then fail closed', async () => {
    routes({
      [ROBOTS]: empty(301, 'https://example.com/r1'),
      'https://example.com/r1': empty(301, 'https://example.com/r2'),
      'https://example.com/r2': empty(301, 'https://example.com/r3'),
      'https://example.com/r3': res('User-agent: *\nDisallow:\n', { contentType: 'text/plain' }),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'robots_unavailable' });
  });

  test('a redirect within the cap to a public host is followed and honoured', async () => {
    routes({
      [ROBOTS]: empty(301, 'https://www.example.com/robots.txt'),
      'https://www.example.com/robots.txt': res('User-agent: *\nDisallow: /articles/\n', { contentType: 'text/plain' }),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false, signal: 'robots_disallow' });
  });

  test('only the two well-known paths are ever fetched, each with our declared user agent', async () => {
    allowAll();
    await checkUrlReservation(ARTICLE);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0])).sort();
    expect(urls).toEqual([TDM, ROBOTS].sort());
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)['user-agent']).toBe(STRIVE_FETCH_USER_AGENT);
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeDefined();
    }
  });
});

// ── Per-host cache ────────────────────────────────────────

describe('checkUrlReservation — per-host cache', () => {
  test('a second URL on the same host inside the TTL performs no new fetch', async () => {
    routes({
      [ROBOTS]: res('User-agent: *\nDisallow: /private/\n', { contentType: 'text/plain' }),
      [TDM]: empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Different path, same host: the cached documents are re-evaluated.
    await expect(checkUrlReservation('https://example.com/private/secret')).resolves.toMatchObject({
      allowed: false,
      signal: 'robots_disallow',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // One resolve per well-known request, and none at all on the cache hit.
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  test('a fail-closed verdict is cached only briefly, so one blip does not brand a host for a day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00Z'));
    routes({ [ROBOTS]: empty(503), [TDM]: empty(404) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false });
    const afterFirst = fetchSpy.mock.calls.length;

    // Immediately again: served from the short-lived negative entry.
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: false });
    expect(fetchSpy.mock.calls.length).toBe(afterFirst);

    // Past the error TTL the host is re-checked and recovers.
    vi.setSystemTime(new Date('2026-07-30T12:30:00Z'));
    routes({ [ROBOTS]: empty(404), [TDM]: empty(404) });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true, signal: 'no_reservation' });
  });

  test('a different host is a different cache entry', async () => {
    routes({
      [ROBOTS]: empty(404),
      [TDM]: empty(404),
      'https://other.test/robots.txt': res('User-agent: *\nDisallow: /\n', { contentType: 'text/plain' }),
      'https://other.test/.well-known/tdmrep.json': empty(404),
    });
    await expect(checkUrlReservation(ARTICLE)).resolves.toMatchObject({ allowed: true });
    await expect(checkUrlReservation('https://other.test/a')).resolves.toMatchObject({ allowed: false });
  });
});

// ── Content-leak canary ───────────────────────────────────

describe('checkUrlReservation — never echoes fetched third-party content', () => {
  test('nothing from the robots/tdm bodies reaches the verdict or stdout', async () => {
    const CANARY = 'CANARY-9f3ab7-secret-third-party-text';
    routes({
      [ROBOTS]: res(`# ${CANARY}\nUser-agent: *\nDisallow: /articles/ # ${CANARY}\n`, { contentType: 'text/plain' }),
      [TDM]: res(JSON.stringify([{ location: `/${CANARY}`, 'tdm-reservation': 1 }]), {
        contentType: 'application/json',
      }),
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const verdict = await checkUrlReservation(ARTICLE);
      expect(verdict.allowed).toBe(false);
      expect(JSON.stringify(verdict)).not.toContain(CANARY);
      const written = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .flat()
        .map((a) => String(a))
        .join('\n');
      expect(written).not.toContain(CANARY);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
