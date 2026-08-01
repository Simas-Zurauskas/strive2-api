/**
 * `jinaReader.readUrl` — the shared choke point for reading a
 * user-influenced web page.
 *
 * These tests exist because of a real gap: the rights-reservation gate
 * (robots.txt RFC 9309 + TDM reservation) shipped wired into exactly ONE
 * of four outbound fetch paths, while the published Terms §6.3 / Privacy
 * §12 promise it runs before *every* fetch. The fix moved the gate inside
 * `readUrl`, so what has to be pinned is:
 *
 *   1. the gate runs BEFORE the network call, not after;
 *   2. a refusal short-circuits — the page is never fetched;
 *   3. an allowed URL still fetches exactly as before;
 *   4. there is no bypass parameter, and no *other* module talks to the
 *      Jina reader endpoint behind the gate's back (the source scan at the
 *      bottom is the thing that fails when someone adds a fifth path).
 *
 * Run: yarn test jinaReader
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { checkUrlReservationMock, recordUsageMock } = vi.hoisted(() => ({
  checkUrlReservationMock: vi.fn(),
  recordUsageMock: vi.fn(),
}));

vi.mock('@services/urlReservationCheck', () => ({
  checkUrlReservation: checkUrlReservationMock,
}));
vi.mock('@services/usageService', () => ({ recordUsage: recordUsageMock }));

import { readUrl } from './jinaReader';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

const allow = () => ({ allowed: true, signal: 'no_reservation', checkedAt: new Date() });
const blockWith = (signal: string) => ({
  allowed: false,
  signal,
  reason: 'category-level reason',
  checkedAt: new Date(),
});

const okResponse = (body = 'extracted page text') =>
  new Response(body, { status: 200, headers: { 'x-total-tokens': '42' } });

beforeEach(() => {
  checkUrlReservationMock.mockReset();
  recordUsageMock.mockReset();
  // NB: no `vi.restoreAllMocks()` in an afterEach — that un-installs the
  // `fetch` spy for every later test in the file, which silently lets a
  // "did we call the network?" assertion make a real request.
  fetchSpy.mockReset();
});

describe('readUrl — rights-reservation gate', () => {
  test('proceeds to the reader when the host reserves nothing', async () => {
    checkUrlReservationMock.mockResolvedValue(allow());
    fetchSpy.mockResolvedValue(okResponse());

    const result = await readUrl({ url: 'https://example.com/article', action: 'test:fetch' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.text).toBe('extracted page text');
    expect(checkUrlReservationMock).toHaveBeenCalledWith('https://example.com/article');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('refuses a reserved URL and never touches the reader', async () => {
    checkUrlReservationMock.mockResolvedValue(blockWith('robots_disallow'));

    const result = await readUrl({ url: 'https://example.com/article', action: 'test:fetch' });

    expect(result).toEqual({ ok: false, error: 'reserved' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('refuses on every non-allowed verdict, including the fail-closed ones', async () => {
    for (const signal of [
      'robots_disallow',
      'tdm_reservation',
      'robots_unavailable',
      'tdm_unavailable',
      'tdm_malformed',
      'host_unresolvable',
    ]) {
      checkUrlReservationMock.mockResolvedValue(blockWith(signal));
      const result = await readUrl({ url: 'https://example.com/a', action: 'test:fetch' });
      expect(result, signal).toEqual({ ok: false, error: 'reserved' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a refusal never bills the reader', async () => {
    checkUrlReservationMock.mockResolvedValue(blockWith('tdm_reservation'));
    await readUrl({ url: 'https://example.com/a', action: 'test:fetch' });
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  test('the gate runs BEFORE the fetch, not alongside it', async () => {
    const order: string[] = [];
    checkUrlReservationMock.mockImplementation(async () => {
      order.push('gate');
      return allow();
    });
    fetchSpy.mockImplementation(async () => {
      order.push('fetch');
      return okResponse();
    });

    await readUrl({ url: 'https://example.com/a', action: 'test:fetch' });

    expect(order).toEqual(['gate', 'fetch']);
  });

  test('an unsafe URL is rejected before the gate is even consulted', async () => {
    const result = await readUrl({ url: 'http://169.254.169.254/latest', action: 'test:fetch' });

    expect(result).toEqual({ ok: false, error: 'unsafe_url' });
    expect(checkUrlReservationMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the gate cannot be switched off: readUrl accepts no opt-out option', async () => {
    checkUrlReservationMock.mockResolvedValue(blockWith('robots_disallow'));

    // A caller trying every plausible escape hatch still gets refused.
    const attempt = await readUrl({
      url: 'https://example.com/a',
      action: 'test:fetch',
      // @ts-expect-error — deliberately probing for a bypass parameter that
      // must not exist; if someone adds one, this line stops erroring and
      // the assertion below starts failing.
      skipReservationCheck: true,
    });

    expect(attempt).toEqual({ ok: false, error: 'reserved' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Structural guard: no fifth fetch path ─────────────────
//
// The unit tests above prove `readUrl` is gated. They cannot prove a new
// module won't call `https://r.jina.ai/` directly the way `fetchContent.ts`
// historically did. This scan does: the reader endpoint may appear only in
// files that are known to run the gate.

const API_SRC = path.resolve(__dirname, '..');
const READER_HOST = 'r.jina.ai';

/** Files allowed to name the reader endpoint, each verified gated. */
const GATED_READER_CALLERS = new Set([
  // gate lives inside readUrl itself
  path.join('lib', 'jinaReader.ts'),
  // batch link-judging path: calls checkUrlReservation at its own call site
  path.join('lib', 'ai', 'agents', 'lessonGeneration', 'links', 'fetchContent.ts'),
]);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });

describe('choke point — nothing reaches the reader around the gate', () => {
  test(`only known-gated files reference ${READER_HOST}`, () => {
    const offenders = walk(API_SRC)
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes(READER_HOST))
      .map((f) => path.relative(API_SRC, f))
      .filter((rel) => !GATED_READER_CALLERS.has(rel))
      .sort();

    expect(
      offenders,
      'A new file fetches the Jina reader directly. Either route it through ' +
        '`jinaReader.readUrl` (gated) or call `checkUrlReservation` at the call ' +
        'site and add it to GATED_READER_CALLERS — our Terms §6.3 promise the ' +
        'gate runs before every fetch.',
    ).toEqual([]);
  });

  test('every allowed caller actually invokes the gate', () => {
    for (const rel of GATED_READER_CALLERS) {
      const source = readFileSync(path.join(API_SRC, rel), 'utf8');
      expect(source, rel).toContain('checkUrlReservation');
    }
  });
});
