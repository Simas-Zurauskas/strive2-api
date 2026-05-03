import { JINA_API_KEY } from '@conf/env';
import { priceLlmUsage } from '@lib/pricing';
import { recordUsage } from '@services/usageService';
import { integrationLog } from '@lib/loggers';

/**
 * Generic Jina Reader wrapper used by the mentor's `fetch_url` tool.
 *
 * Strives/lessonGeneration has its own per-batch fetch path
 * (`fetchContent.ts`) tuned for the link-judging pipeline (5x concurrency,
 * 4K-char trim, custom failure metrics). This helper is the pared-down
 * single-URL version: SSRF guard, timeout, usage recording, plus a
 * configurable trim cap so the mentor can pull more characters than the
 * link judge needs.
 *
 * Returns null on any failure (caller surfaces "I couldn't fetch that"
 * to the model). Cost is recorded only on the paid tier (JINA_API_KEY
 * set) — free tier requests don't produce a ledger row.
 */

const JINA_READER_BASE = 'https://r.jina.ai/';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CHARS = 8_000;

/**
 * SSRF defense: reject schemes other than http(s), localhost, and RFC1918
 * private ranges. Identical to lessonGeneration/links/fetchContent.ts so
 * any future hardening can be applied in both call sites.
 */
const isSafeHttpsUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return false;
    if (/^127\./.test(host)) return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
};

export interface ReadUrlResult {
  url: string;
  text: string;
  tokens: number;
  truncated: boolean;
}

export type ReadUrlError =
  | 'invalid_url'
  | 'unsafe_url'
  | 'timeout'
  | 'http_error'
  | 'empty_body';

/**
 * Fetch the main-text extraction of a URL via Jina Reader. Returns the
 * trimmed text and token count, or an error code on failure.
 */
export const readUrl = async ({
  url,
  maxChars = DEFAULT_MAX_CHARS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  action,
}: {
  url: string;
  maxChars?: number;
  timeoutMs?: number;
  /** Logged in usage metadata for attribution (e.g. 'mentor:fetch_url'). */
  action: string;
}): Promise<{ ok: true; data: ReadUrlResult } | { ok: false; error: ReadUrlError }> => {
  if (!url || typeof url !== 'string') return { ok: false, error: 'invalid_url' };
  if (!isSafeHttpsUrl(url)) return { ok: false, error: 'unsafe_url' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      accept: 'text/plain',
      'x-return-format': 'text',
    };
    if (JINA_API_KEY) headers.authorization = `Bearer ${JINA_API_KEY}`;

    const res = await fetch(`${JINA_READER_BASE}${url}`, {
      signal: controller.signal,
      headers,
    });

    if (!res.ok) {
      integrationLog.warn(`jina:${action} http-error status=${res.status} url=${url}`);
      return { ok: false, error: 'http_error' };
    }

    const body = (await res.text()).trim();
    if (!body) {
      integrationLog.warn(`jina:${action} empty-body url=${url}`);
      return { ok: false, error: 'empty_body' };
    }

    // Token count: prefer the authoritative response header, fall back to
    // chars/4 approximation when absent (free tier responses sometimes omit
    // the header). Same approach as fetchContent.ts.
    const headerTokens = Number(res.headers.get('x-total-tokens'));
    const tokens =
      Number.isFinite(headerTokens) && headerTokens > 0
        ? Math.round(headerTokens)
        : Math.ceil(body.length / 4);

    if (JINA_API_KEY) {
      recordUsage({
        service: 'jina',
        action,
        costMicroCents: priceLlmUsage({
          model: 'jina_reader_paid',
          uncached: tokens,
          cacheRead: 0,
          cacheCreation5m: 0,
          cacheCreation1h: 0,
          output: 0,
        }),
        metadata: {
          url,
          bytes: body.length,
          tokens,
          tokenSource:
            Number.isFinite(headerTokens) && headerTokens > 0 ? 'header' : 'chars-approx',
        },
      });
    }

    const trimmed = body.slice(0, maxChars);
    const truncated = body.length > maxChars;
    integrationLog.info(
      `jina:${action} ok url=${url} bytes=${body.length} tokens=${tokens}${truncated ? ` trimmedTo=${maxChars}` : ''}`,
    );

    return {
      ok: true,
      data: {
        url,
        text: trimmed,
        tokens,
        truncated,
      },
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const errorCode: ReadUrlError = isAbort ? 'timeout' : 'http_error';
    integrationLog.warn(`jina:${action} ${errorCode} url=${url} reason=${err instanceof Error ? err.message : err}`);
    return { ok: false, error: errorCode };
  } finally {
    clearTimeout(timer);
  }
};
