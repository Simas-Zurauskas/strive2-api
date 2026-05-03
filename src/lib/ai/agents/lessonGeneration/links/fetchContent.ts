import pLimit from 'p-limit';
import { JINA_API_KEY } from '@conf/env';
import { bumpLinksFetchFailure } from '@lib/metrics';
import { priceLlmUsage } from '@lib/pricing';
import { recordUsage } from '@services/usageService';
import { genLog } from '@lib/loggers';
import { FetchedCandidate, SearchCandidate } from './schemas';

const JINA_READER_BASE = 'https://r.jina.ai/';
// 10s per URL: the prior 6s cap was dropping a long tail of slow-responding
// sites (metrics showed ~25% of fetch failures bucketed as `timeout`). 10s
// still bounds the stage wall-clock at ~20s for the full batch (concurrency 5,
// ~10 candidates per lesson).
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONTENT_CHARS = 4_000;
const CONCURRENCY = 5;

// Small belt against file://, javascript:, data:, localhost, and IP literals
// sneaking past the dedupe stage. Dedupe already rejects these, but the fetch
// layer is what actually resolves the URL — we guard here too so a future
// dedupe change can't open an SSRF foothole.
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

const fetchOne = async (candidate: SearchCandidate): Promise<FetchedCandidate | null> => {
  if (!isSafeHttpsUrl(candidate.url)) {
    bumpLinksFetchFailure('ssrf_reject');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // Jina Reader accepts a bare URL in the path and returns extracted
    // markdown of the main content. No API key required on the free tier.
    const readerUrl = `${JINA_READER_BASE}${candidate.url}`;
    const headers: Record<string, string> = {
      accept: 'text/plain',
      // Ask the reader to return plain-text content rather than the default
      // structured markdown envelope — shorter, easier for the judge to read.
      'x-return-format': 'text',
    };
    // Paid tier (when JINA_API_KEY is set): 200 req/min vs the free 20. The
    // pipeline gracefully falls back to the free tier when the key is empty.
    if (JINA_API_KEY) headers.authorization = `Bearer ${JINA_API_KEY}`;

    const res = await fetch(readerUrl, {
      signal: controller.signal,
      headers,
    });

    if (!res.ok) {
      bumpLinksFetchFailure('http_error');
      return null;
    }

    const body = await res.text();
    const trimmed = body.trim();
    if (!trimmed) {
      bumpLinksFetchFailure('empty_body');
      return null;
    }

    // Only the paid tier is billed; the free tier (JINA_API_KEY unset) stays
    // free and does not produce a ledger row. Jina Reader bills per token
    // returned at $0.05/MTok: prefer the `x-total-tokens` response header
    // (authoritative count from the provider) and fall back to chars/4 — the
    // standard tokens≈chars/4 approximation — when the header is absent so
    // we never silently record cost=0 for a real billed call.
    if (JINA_API_KEY) {
      const headerTokens = Number(res.headers.get('x-total-tokens'));
      const tokens = Number.isFinite(headerTokens) && headerTokens > 0
        ? Math.round(headerTokens)
        : Math.ceil(trimmed.length / 4);
      recordUsage({
        service: 'jina',
        action: 'reader:fetch',
        costMicroCents: priceLlmUsage({
          model: 'jina_reader_paid',
          uncached: tokens,
          cacheRead: 0,
          cacheCreation5m: 0,
          cacheCreation1h: 0,
          output: 0,
        }),
        metadata: {
          url: candidate.url,
          hostname: candidate.hostname,
          bytes: trimmed.length,
          tokens,
          tokenSource: Number.isFinite(headerTokens) && headerTokens > 0 ? 'header' : 'chars-approx',
        },
      });
    }

    return {
      ...candidate,
      fetchedContent: trimmed.slice(0, MAX_CONTENT_CHARS),
    };
  } catch (e) {
    const reason = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'http_error';
    bumpLinksFetchFailure(reason);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Fetch full main-content markdown for each candidate via Jina Reader.
 *
 * Concurrency is bounded to 5 per lesson so one lesson can't exhaust the
 * free-tier rate limit (~20 req/min/IP). A per-URL 6-second timeout keeps
 * the total stage duration bounded even when a tail of candidates hangs.
 * Dropped candidates (timeout, 4xx, 5xx, empty body, SSRF reject) never fail
 * the pipeline — the judge stage simply has fewer to score.
 */
export const fetchCandidateContent = async ({
  candidates,
}: {
  candidates: SearchCandidate[];
}): Promise<FetchedCandidate[]> => {
  const limit = pLimit(CONCURRENCY);
  const results = await Promise.all(candidates.map((c) => limit(() => fetchOne(c))));
  const fetched = results.filter((r): r is FetchedCandidate => r !== null);
  genLog.info(`links:fetch fetched=${fetched.length}/${candidates.length} via=jina`);
  return fetched;
};
