import { readUrl } from '@lib/jinaReader';
import { URL_BLOCKED_BY_RESERVATION } from '@lib/constants';
import { checkUrlReservation, RESERVATION_BLOCK_REASONS } from '@services/urlReservationCheck';
import {
  ExtractionError,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
  normalizeExtractedText,
} from './types';

/**
 * URL documents: the PAGE is fetched EXCLUSIVELY through the existing
 * Jina Reader integration (`lib/jinaReader.readUrl` — SSRF guard,
 * timeout, and `jina_reader_paid` usage recording live there). Our
 * servers never dereference a user-controlled path directly (plan §3.5),
 * and Phase 1's `validateSourceUrl` already gated the URL's shape at the
 * endpoint.
 *
 * The returned markdown IS the snapshot: the Phase-4 ingest job
 * persists `result.markdown` to the document's reserved S3 key so
 * provenance survives the page changing later.
 *
 * BEFORE any of that, the rights-reservation gate runs
 * (`services/urlReservationCheck` — robots.txt per RFC 9309 for our
 * declared product token, plus `/.well-known/tdmrep.json`). The gate
 * reads two FIXED well-known paths on the origin — it still never
 * dereferences the user's own path, which stays the reader's job.
 *
 * The gate is ALSO run inside `jinaReader.readUrl` itself, which is the
 * enforcement point for every other fetch path (mentor `fetch_url`,
 * product-KB `fetch_url`). It is called here as well — not redundantly —
 * because this path needs two things the reader cannot give it: the
 * verdict's audit pair (`reservationSignal`/`reservationCheckedAt`, both
 * persisted on the SourceDocument) and a typed per-document
 * `URL_BLOCKED_BY_RESERVATION` rejection so sibling documents in the same
 * corpus keep parsing. The second call is a per-host cache hit.
 *
 * A refusal is a per-document rejection carrying only the signal name;
 * sibling documents in the same corpus continue to parse.
 */

/** Response-size cap for a single article snapshot (~75K tokens). */
export const URL_SNAPSHOT_MAX_CHARS = 300_000;
const URL_FETCH_TIMEOUT_MS = 30_000;

export const extractUrl = async (
  input: ExtractionInput,
  _opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  const url = input.sourceUrl;
  if (!url) {
    throw new ExtractionError('url_fetch_failed', 'no source URL on the document');
  }

  // Rights-reservation pre-flight. The message is LOOKED UP by signal
  // rather than taken from the verdict, so no string that ever touched a
  // third-party document can reach an error, a log line, or the client.
  const reservation = await checkUrlReservation(url);
  if (!reservation.allowed && reservation.signal !== 'no_reservation') {
    throw new ExtractionError(URL_BLOCKED_BY_RESERVATION, RESERVATION_BLOCK_REASONS[reservation.signal], {
      signal: reservation.signal,
      checkedAt: reservation.checkedAt,
    });
  }

  const result = await readUrl({
    url,
    maxChars: URL_SNAPSHOT_MAX_CHARS,
    timeoutMs: URL_FETCH_TIMEOUT_MS,
    action: 'doc:fetch_url',
  });

  if (!result.ok) {
    throw new ExtractionError('url_fetch_failed', `could not fetch the page (${result.error})`, {
      error: result.error,
    });
  }

  const warnings: string[] = [];
  if (result.data.truncated) {
    warnings.push(`url: page content truncated to ${URL_SNAPSHOT_MAX_CHARS} characters`);
  }

  // Jina Reader already returns main-content text/markdown — wrap it
  // directly into the contract (no HTML to re-walk), through the same
  // normalization every other path gets.
  const markdown = normalizeExtractedText(result.data.text);
  if (!markdown) {
    throw new ExtractionError('url_fetch_failed', 'the page had no extractable content', {
      error: 'empty_body',
    });
  }

  return {
    markdown,
    blocks: [{ type: 'text', markdown, headingPath: [] }],
    warnings,
    reservation: { signal: reservation.signal, checkedAt: reservation.checkedAt },
  };
};
