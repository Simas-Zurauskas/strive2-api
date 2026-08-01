import { JINA_API_KEY } from '@conf/env';
import { priceLlmUsage } from '@lib/pricing';
import { recordUsage } from '@services/usageService';
import { integrationLog } from '@lib/loggers';
import { isSafeHttpsUrl } from '@lib/urlSafety';
import { checkUrlReservation } from '@services/urlReservationCheck';

/**
 * Generic Jina Reader wrapper — the shared choke point for reading a
 * user-influenced web page.
 *
 * Strives/lessonGeneration has its own per-batch fetch path
 * (`fetchContent.ts`) tuned for the link-judging pipeline (5x concurrency,
 * 4K-char trim, custom failure metrics). This helper is the pared-down
 * single-URL version: SSRF guard, rights-reservation gate, timeout, usage
 * recording, plus a configurable trim cap so the mentor can pull more
 * characters than the link judge needs.
 *
 * ── The rights-reservation gate is INSIDE this function, on purpose ──
 * Our published Terms (§6.3) and Privacy Policy (§12) promise that a
 * machine-readable reservation (robots.txt / TDM) is honoured *before
 * every fetch*. That promise was previously kept only by
 * `documentExtraction/url.ts`, which called the gate at its own call
 * site — the mentor's `fetch_url`, the product-KB agent's `fetch_url`, and
 * the link-judging batch all reached Jina without it. Putting the gate
 * here means a NEW caller of `readUrl` inherits it rather than having to
 * remember it; the only remaining ungated fetch path would be one that
 * re-implements the reader call, which `jinaReaderChokePoint.test.ts`
 * pins by asserting that the reader base URL appears in exactly the two
 * gated files.
 *
 * A refusal is returned as the ordinary `{ok:false}` shape with the
 * `reserved` code, so every existing caller degrades exactly as it already
 * does on a failed fetch — the mentor returns its normal "couldn't fetch"
 * JSON rather than throwing inside a chat turn.
 *
 * Cost is recorded only on the paid tier (JINA_API_KEY set) — free tier
 * requests don't produce a ledger row.
 */

const JINA_READER_BASE = 'https://r.jina.ai/';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CHARS = 8_000;

export interface ReadUrlResult {
  url: string;
  text: string;
  tokens: number;
  truncated: boolean;
}

export type ReadUrlError =
  | 'invalid_url'
  | 'unsafe_url'
  | 'reserved'
  | 'timeout'
  | 'http_error'
  | 'empty_body';

/**
 * Fetch the main-text extraction of a URL via Jina Reader. Returns the
 * trimmed text and token count, or an error code on failure.
 *
 * There is deliberately NO opt-out parameter. `documentExtraction/url.ts`
 * still runs the gate at its own call site because it needs the verdict's
 * audit fields (`reservationSignal`/`checkedAt` are persisted on the
 * SourceDocument) and a typed per-document rejection; the second check
 * here is a per-host cache hit, so the cost of having no bypass flag is
 * one map lookup and the benefit is that no caller can ever ask for one.
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

  // Rights-reservation pre-flight (see the header note). The gate never
  // throws and never surfaces bytes from the fetched document — only the
  // signal name reaches a log line, and callers get a category-level code.
  const reservation = await checkUrlReservation(url);
  if (!reservation.allowed) {
    integrationLog.info(`jina:${action} reserved signal=${reservation.signal} url=${url}`);
    return { ok: false, error: 'reserved' };
  }

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
