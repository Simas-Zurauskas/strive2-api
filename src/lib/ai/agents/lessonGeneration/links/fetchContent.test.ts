/**
 * Link-judging fetch path — rights-reservation gate.
 *
 * This is the one outbound page-fetch path that does NOT go through
 * `jinaReader.readUrl` (it has its own bounded-concurrency batch fetch with
 * custom failure metrics, and the generation pipeline is a protected
 * surface), so the gate is wired at its own call site and pinned here.
 *
 * The contract that matters legally: a reserved candidate is never fetched.
 * The contract that matters operationally: a refusal is an ordinary dropped
 * candidate — the batch keeps going and the judge stage just scores fewer.
 *
 * Run: yarn test fetchContent
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { checkUrlReservationMock, recordUsageMock } = vi.hoisted(() => ({
  checkUrlReservationMock: vi.fn(),
  recordUsageMock: vi.fn(),
}));

vi.mock('@services/urlReservationCheck', () => ({
  checkUrlReservation: checkUrlReservationMock,
}));
vi.mock('@services/usageService', () => ({ recordUsage: recordUsageMock }));

import { fetchCandidateContent } from './fetchContent';
import { linksFetchFailure } from '@lib/metrics';
import { SearchCandidate } from './schemas';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

const candidate = (url: string): SearchCandidate => ({
  id: url,
  url,
  title: 'A title',
  snippet: 'A snippet',
  hostname: new URL(url).hostname,
  score: 1,
  queryTopic: 'topic',
});

const allow = () => ({ allowed: true, signal: 'no_reservation', checkedAt: new Date() });
const blocked = (signal: string) => ({
  allowed: false,
  signal,
  reason: 'category-level reason',
  checkedAt: new Date(),
});

beforeEach(() => {
  checkUrlReservationMock.mockReset();
  recordUsageMock.mockReset();
  fetchSpy.mockReset();
  for (const key of Object.keys(linksFetchFailure) as (keyof typeof linksFetchFailure)[]) {
    linksFetchFailure[key] = 0;
  }
  // NB: no `vi.restoreAllMocks()` in an afterEach — it un-installs the
  // `fetch` spy for the rest of the file and turns a "we never fetched"
  // assertion into a real outbound request.
});

describe('fetchCandidateContent — rights-reservation gate', () => {
  test('fetches a candidate whose host reserves nothing', async () => {
    checkUrlReservationMock.mockResolvedValue(allow());
    fetchSpy.mockResolvedValue(new Response('page body', { status: 200 }));

    const out = await fetchCandidateContent({ candidates: [candidate('https://example.com/a')] });

    expect(out).toHaveLength(1);
    expect(out[0].fetchedContent).toBe('page body');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('drops a reserved candidate without fetching it', async () => {
    checkUrlReservationMock.mockResolvedValue(blocked('robots_disallow'));

    const out = await fetchCandidateContent({ candidates: [candidate('https://example.com/a')] });

    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(linksFetchFailure.reserved).toBe(1);
  });

  test('a refusal degrades gracefully — siblings in the batch still fetch', async () => {
    checkUrlReservationMock.mockImplementation(async (url: string) =>
      url.includes('reserved.example') ? blocked('tdm_reservation') : allow(),
    );
    fetchSpy.mockResolvedValue(new Response('page body', { status: 200 }));

    const out = await fetchCandidateContent({
      candidates: [
        candidate('https://reserved.example/a'),
        candidate('https://open.example/b'),
      ],
    });

    expect(out.map((c) => c.url)).toEqual(['https://open.example/b']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(linksFetchFailure.reserved).toBe(1);
  });

  test('the gate is consulted before the SSRF-safe URL is ever dereferenced', async () => {
    const order: string[] = [];
    checkUrlReservationMock.mockImplementation(async () => {
      order.push('gate');
      return allow();
    });
    fetchSpy.mockImplementation(async () => {
      order.push('fetch');
      return new Response('page body', { status: 200 });
    });

    await fetchCandidateContent({ candidates: [candidate('https://example.com/a')] });

    expect(order).toEqual(['gate', 'fetch']);
  });

  test('an SSRF-unsafe candidate is dropped before the gate is consulted', async () => {
    const out = await fetchCandidateContent({ candidates: [candidate('https://127.0.0.1/a')] });

    expect(out).toEqual([]);
    expect(checkUrlReservationMock).not.toHaveBeenCalled();
    expect(linksFetchFailure.ssrf_reject).toBe(1);
  });
});
