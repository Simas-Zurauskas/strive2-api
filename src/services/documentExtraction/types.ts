import { SourceChunkType, SourceDocumentKind, URL_BLOCKED_BY_RESERVATION } from '@lib/constants';
import type { UrlReservationAudit } from '@services/urlReservationCheck';

/**
 * Stable output contract of the document-extraction layer (Phase 2 of the
 * course-from-documents plan). Downstream phases — moderation (3), the
 * ingest job + chunking/embedding (4), prompt integration (5) — depend
 * ONLY on this shape. Swapping a parser (or the vision escalation model)
 * must never change it.
 *
 * Trust model: documents are hostile input (plan A8). Everything leaving
 * this layer has been through `normalizeExtractedText` (NFKC + zero-width
 * strip + control-char strip); prompt-side wrapping/sanitizing is the
 * consumer's job, not ours.
 */

export interface ExtractionBlock {
  /** `text` | `table` | `figure` — tables/figures stay atomic downstream. */
  type: SourceChunkType;
  markdown: string;
  /** 1-based inclusive page range, present when the source is paginated. */
  pageRange?: { start: number; end: number };
  /** Heading breadcrumb ("Chapter 2" → "Setup"), empty when unknown. */
  headingPath: string[];
}

export interface ExtractionResult {
  /** Full document as markdown — the join of `blocks` in order. */
  markdown: string;
  blocks: ExtractionBlock[];
  pageCount?: number;
  /** Extracted text length per page (index 0 = page 1). PDFs only. */
  charsPerPage?: number[];
  /** 1-based pages detected as scanned (< SCANNED_PAGE_CHAR_THRESHOLD chars). */
  scannedPages?: number[];
  /**
   * 1-based scanned pages actually SENT to the vision provider on this run
   * — i.e. pages whose escalation was paid for, whether or not they came
   * back with text. Blank/unreadable scans emit no block, so blocks alone
   * under-report the work done; the ingest/prepare resume marker
   * (`SourceDocument.escalatedPages`, via `deriveEscalatedPages`) needs
   * this to avoid re-escalating the same blank pages on every later run.
   * Absent when no vision call was made (or when the call threw, in which
   * case nothing is claimed — see the degrade path in index.ts).
   */
  visionAttemptedPages?: number[];
  audioDurationSec?: number;
  /** Seconds actually transcribed (≤ duration; triage may transcribe less). */
  transcribedSec?: number;
  /**
   * URL documents only: which rights-reservation signal was honoured, and
   * when it was read. Travels with the result so the ingest job can persist
   * the audit trail without re-running the gate (additive/optional — every
   * file path leaves it absent).
   */
  reservation?: UrlReservationAudit;
  /** Human-readable, category-level warnings. Never echo document content. */
  warnings: string[];
}

export interface ExtractionInput {
  buffer: Buffer;
  /** Server-sniffed MIME (Phase 1's `sniffDocumentType` output — trusted). */
  mimeType: string;
  filename: string;
  kind: SourceDocumentKind;
  /** Required when kind === 'url'. */
  sourceUrl?: string;
}

export interface ExtractionOptions {
  /**
   * `triage` = the free ingest pass: sampled vision escalation, capped
   * audio transcription. `full` = the debited `prepare_corpus` pass.
   */
  mode: 'triage' | 'full';
  /**
   * Remaining per-course vision-page budget (A9: ≤100 escalated pages per
   * course lifetime — the CALLER tracks the lifetime count via
   * `SourceDocument.escalatedPages`; we enforce the per-call number).
   */
  visionPageBudget?: number;
  /** Triage transcription window in seconds. Default 600 (≈10 min). */
  audioSecondsBudget?: number;
}

// ── Failure taxonomy ───────────────────────────────────────

/**
 * Honest, category-level failure reasons — extends the string-union
 * pattern of `attachmentService.ExtractionError` to the full format set.
 * These surface on `SourceDocument.rejectionReason`/`warnings`; they must
 * never contain document content.
 */
export type ExtractionFailureReason =
  | 'empty_file'
  | 'unsupported_format'
  | 'pdf_password_protected'
  | 'pdf_parse_failed'
  | 'pdf_no_text'
  | 'docx_parse_failed'
  | 'office_parse_failed'
  | 'epub_parse_failed'
  | 'zip_bomb'
  | 'zip_invalid'
  | 'html_parse_failed'
  | 'csv_parse_failed'
  | 'binary_in_text'
  | 'image_convert_failed'
  | 'heic_unsupported'
  | 'audio_parse_failed'
  | 'audio_transcription_failed'
  | 'url_fetch_failed'
  // Refused BEFORE any fetch by the rights-reservation gate. Typed from the
  // constant so the two can never drift.
  | typeof URL_BLOCKED_BY_RESERVATION
  | 'vision_failed'
  | 'extraction_failed';

/** Typed extraction failure. `message` stays category-level (see above). */
export class ExtractionError extends Error {
  constructor(
    public readonly reason: ExtractionFailureReason,
    message?: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message ?? reason);
    this.name = 'ExtractionError';
  }
}

// ── Shared caps / thresholds ───────────────────────────────

/** < this many extracted chars/page ⇒ page counts as scanned (research §5). */
export const SCANNED_PAGE_CHAR_THRESHOLD = 100;

/** Safety cap on any single extracted document's markdown (~500K tokens). */
export const MAX_EXTRACTED_CHARS = 2_000_000;

/** Default triage transcription window (plan A9: first ~10 min free). */
export const DEFAULT_AUDIO_SECONDS_BUDGET = 600;

/** Default per-call vision budget (A9 course-lifetime cap is also 100). */
export const DEFAULT_VISION_PAGE_BUDGET = 100;

// ── Normalization ──────────────────────────────────────────

// Zero-width + bidi-control characters used to smuggle invisible
// instructions past human review (plan §5 homoglyph/injection edge):
// ZWSP..RLM, LRE..RLO embedding controls, word-joiner..invisible-plus,
// LRI/RLI/FSI/PDI isolates, BOM/ZWNBSP.
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// C0/C1 controls except \t \n \r.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g;

/**
 * NFKC-normalize (folds many homoglyph/compatibility forms), strip
 * zero-width and control characters, collapse >2 consecutive newlines.
 * Applied to every block before it leaves this layer.
 */
export const normalizeExtractedText = (input: string): string =>
  input
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Join blocks into the contract's top-level `markdown`. */
export const blocksToMarkdown = (blocks: ExtractionBlock[]): string =>
  blocks
    .map((b) => b.markdown)
    .filter((m) => m.length > 0)
    .join('\n\n');
