import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { readUrlMock, checkUrlReservationMock } = vi.hoisted(() => ({
  readUrlMock: vi.fn(),
  checkUrlReservationMock: vi.fn(),
}));

vi.mock('@lib/jinaReader', () => ({ readUrl: readUrlMock }));
// Only the gate call is stubbed; the real reason table stays in play so the
// per-signal message lookup is exercised rather than mocked away.
vi.mock('@services/urlReservationCheck', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/urlReservationCheck')>();
  return { ...actual, checkUrlReservation: checkUrlReservationMock };
});

import { URL_BLOCKED_BY_RESERVATION } from '@lib/constants';
import { extractUrl, URL_SNAPSHOT_MAX_CHARS } from './url';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

const CHECKED_AT = new Date('2026-07-30T12:00:00Z');

const input = (sourceUrl?: string) => ({
  buffer: Buffer.alloc(0),
  mimeType: 'text/html',
  filename: sourceUrl ?? 'x',
  kind: 'url' as const,
  ...(sourceUrl ? { sourceUrl } : {}),
});

beforeEach(() => {
  readUrlMock.mockReset();
  checkUrlReservationMock.mockReset();
  checkUrlReservationMock.mockResolvedValue({ allowed: true, signal: 'no_reservation', checkedAt: CHECKED_AT });
  fetchSpy.mockClear();
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // NO direct fetch of user URLs, ever.
});

describe('extractUrl', () => {
  it('routes through jinaReader and wraps the snapshot into the contract', async () => {
    readUrlMock.mockResolvedValue({
      ok: true,
      data: {
        url: 'https://example.com/article',
        text: '# Article Title\n\nBody of the article about learning.',
        tokens: 40,
        truncated: false,
      },
    });
    const result = await extractUrl(input('https://example.com/article'), { mode: 'triage' });
    expect(readUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/article',
        action: 'doc:fetch_url',
        maxChars: URL_SNAPSHOT_MAX_CHARS,
      }),
    );
    expect(result.markdown).toContain('Body of the article');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe('text');
    expect(result.warnings).toEqual([]);
    // Audit trail travels with the result so the ingest job can persist it.
    expect(result.reservation).toEqual({ signal: 'no_reservation', checkedAt: CHECKED_AT });
  });

  it('warns when the response was size-capped', async () => {
    readUrlMock.mockResolvedValue({
      ok: true,
      data: { url: 'https://e.com', text: 'partial content here', tokens: 5, truncated: true },
    });
    const result = await extractUrl(input('https://e.com'), { mode: 'triage' });
    expect(result.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  it('maps jina failures to url_fetch_failed with the honest reason in meta', async () => {
    readUrlMock.mockResolvedValue({ ok: false, error: 'http_error' });
    await expect(extractUrl(input('https://e.com'), { mode: 'triage' })).rejects.toMatchObject({
      name: 'ExtractionError',
      reason: 'url_fetch_failed',
      meta: { error: 'http_error' },
    });
  });

  it('rejects when sourceUrl is missing', async () => {
    await expect(extractUrl(input(), { mode: 'triage' })).rejects.toMatchObject({ reason: 'url_fetch_failed' });
    expect(checkUrlReservationMock).not.toHaveBeenCalled();
  });
});

describe('extractUrl — rights-reservation gate', () => {
  it('checks the reservation BEFORE any fetch of the page', async () => {
    const order: string[] = [];
    checkUrlReservationMock.mockImplementation(async () => {
      order.push('gate');
      return { allowed: true, signal: 'no_reservation', checkedAt: CHECKED_AT };
    });
    readUrlMock.mockImplementation(async () => {
      order.push('readUrl');
      return { ok: true, data: { url: 'https://e.com', text: 'content', tokens: 2, truncated: false } };
    });
    await extractUrl(input('https://e.com/a'), { mode: 'triage' });
    expect(order).toEqual(['gate', 'readUrl']);
    expect(checkUrlReservationMock).toHaveBeenCalledWith('https://e.com/a');
  });

  it('a blocked verdict throws the typed extraction error and NEVER fetches the page', async () => {
    checkUrlReservationMock.mockResolvedValue({
      allowed: false,
      signal: 'robots_disallow',
      reason: 'the publisher reserves this page from automated use',
      checkedAt: CHECKED_AT,
    });
    await expect(extractUrl(input('https://reserved.test/a'), { mode: 'triage' })).rejects.toMatchObject({
      name: 'ExtractionError',
      reason: URL_BLOCKED_BY_RESERVATION,
      meta: { signal: 'robots_disallow', checkedAt: CHECKED_AT },
    });
    expect(readUrlMock).not.toHaveBeenCalled();
  });

  it('a fail-closed verdict (5xx / timeout / malformed) also blocks the fetch', async () => {
    for (const signal of ['robots_unavailable', 'tdm_unavailable', 'tdm_malformed', 'unsafe_host']) {
      readUrlMock.mockClear();
      checkUrlReservationMock.mockResolvedValue({ allowed: false, signal, checkedAt: CHECKED_AT });
      await expect(extractUrl(input('https://x.test/a'), { mode: 'triage' })).rejects.toMatchObject({
        reason: URL_BLOCKED_BY_RESERVATION,
        meta: { signal },
      });
      expect(readUrlMock).not.toHaveBeenCalled();
    }
  });

  it('the thrown message stays category-level and carries no fetched content', async () => {
    const CANARY = 'CANARY-b41c-third-party-body';
    checkUrlReservationMock.mockResolvedValue({
      allowed: false,
      signal: 'robots_disallow',
      reason: `the publisher reserves this page from automated use (${CANARY})`,
      checkedAt: CHECKED_AT,
    });
    // Even if a verdict reason were ever polluted, extractUrl must not
    // forward it verbatim into the extraction error.
    const err = await extractUrl(input('https://reserved.test/a'), { mode: 'triage' }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(CANARY);
  });
});
