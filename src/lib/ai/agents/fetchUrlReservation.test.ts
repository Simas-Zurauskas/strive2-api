/**
 * `fetch_url` tools (lesson mentor + product-KB agent) — graceful
 * degradation when the rights-reservation gate refuses a page.
 *
 * The gate now lives inside `jinaReader.readUrl`, so these tools inherited
 * it without a code change at their call sites. What has to be pinned is
 * that the new `reserved` error code does NOT crash a chat turn: the tool
 * must return its ordinary failed-fetch JSON, exactly as it already does
 * for a 404 or a timeout, with an honest message rather than the generic
 * fallback.
 *
 * Run: yarn test fetchUrlReservation
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { readUrlMock } = vi.hoisted(() => ({ readUrlMock: vi.fn() }));

vi.mock('@lib/jinaReader', () => ({ readUrl: readUrlMock }));

import { fetchUrlTool as lessonMentorFetchUrl } from './lessonMentor/tools';
import { fetchUrlTool as productKbFetchUrl } from './productKb/tools';

const TOOLS = [
  ['lessonMentor', lessonMentorFetchUrl],
  ['productKb', productKbFetchUrl],
] as const;

beforeEach(() => {
  readUrlMock.mockReset();
});

describe.each(TOOLS)('%s fetch_url — reserved URL', (_name, fetchUrlTool) => {
  test('returns the normal failed-fetch shape instead of throwing', async () => {
    readUrlMock.mockResolvedValue({ ok: false, error: 'reserved' });

    const raw = await fetchUrlTool.invoke({ url: 'https://reserved.example/a' });
    const parsed = JSON.parse(raw as string);

    expect(parsed.url).toBe('https://reserved.example/a');
    expect(parsed.error).toBe('reserved');
    expect(parsed.content).toBeUndefined();
  });

  test('explains the refusal rather than falling back to the generic message', async () => {
    readUrlMock.mockResolvedValue({ ok: false, error: 'reserved' });

    const parsed = JSON.parse(
      (await fetchUrlTool.invoke({ url: 'https://reserved.example/a' })) as string,
    );

    expect(parsed.message).not.toBe('Could not fetch the page.');
    expect(parsed.message).toMatch(/robots\.txt|TDM/);
  });

  test('still returns wrapped content when the gate allows the fetch', async () => {
    readUrlMock.mockResolvedValue({
      ok: true,
      data: { url: 'https://open.example/a', text: 'body text', tokens: 3, truncated: false },
    });

    const parsed = JSON.parse(
      (await fetchUrlTool.invoke({ url: 'https://open.example/a' })) as string,
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.content).toContain('body text');
  });
});
