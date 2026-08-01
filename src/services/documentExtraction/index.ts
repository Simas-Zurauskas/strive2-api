import pLimit from 'p-limit';
import { genLog } from '@lib/loggers';
import { extractPdfText } from './pdf';
import { transcribePdfPages, selectTriagePages } from './visionEscalation';
import { extractDocx } from './docx';
import { extractOffice } from './office';
import { extractEpub } from './epub';
import { extractHtml } from './html';
import { extractCsv } from './csv';
import { extractPlainText } from './text';
import { extractImage } from './image';
import { extractAudio } from './audio';
import { extractUrl } from './url';
import {
  DEFAULT_VISION_PAGE_BUDGET,
  ExtractionBlock,
  ExtractionError,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
  MAX_EXTRACTED_CHARS,
  blocksToMarkdown,
} from './types';

/**
 * documentExtraction — Phase 2 of course-from-documents. One entry
 * point, `extractDocument`, routes a sniffed upload (or URL document)
 * to its format module and returns the STABLE contract in `types.ts`.
 *
 * Everything here is pure with respect to the database: no models, no
 * S3, no job state — the Phase-4 ingest job owns persistence. Paid
 * calls (Anthropic vision, OpenAI transcription, Jina fetch) record
 * usage via the existing cost pipeline and therefore must run inside a
 * usage scope (the job runner's) to be billable.
 *
 * Concurrency: local parsing is CPU-heavy and in-process (single-
 * instance service) — a module-level p-limit(2) bounds concurrent
 * parses regardless of how wide the caller fans out.
 */

// Re-export the public surface so consumers import from the package root.
export * from './types';
export { selectTriagePages, transcribePdfPages, transcribeImages, VISION_BATCH_PAGES, ANTHROPIC_MAX_PDF_PAGES } from './visionEscalation';
export { probeAudioDuration, sliceWavToSeconds } from './audio';
export { preScanZip, ZIP_MAX_ENTRIES, ZIP_MAX_UNCOMPRESSED_BYTES } from './zipGuard';
export { URL_SNAPSHOT_MAX_CHARS } from './url';

const parseLimit = pLimit(2);

type Extractor = (input: ExtractionInput, opts: ExtractionOptions) => Promise<ExtractionResult>;

const OFFICE_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
]);

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif']);

const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

const resolveExtractor = (input: ExtractionInput): Extractor | 'pdf' | null => {
  const mime = input.mimeType.toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return extractDocx;
  if (OFFICE_MIMES.has(mime)) return extractOffice;
  if (mime === 'application/epub+zip') return extractEpub;
  if (mime === 'text/html') return extractHtml;
  if (mime === 'text/csv' || mime === 'application/csv') return extractCsv;
  if (mime === 'text/plain' || mime === 'text/markdown' || mime === 'text/x-markdown') return extractPlainText;
  if (IMAGE_MIMES.has(mime)) return extractImage;
  if (AUDIO_MIMES.has(mime)) return extractAudio;
  return null;
};

/**
 * Test-only view of the router table so the upload allowlist and this
 * dispatch can be pinned in parity (see index.test.ts). Not used at runtime.
 */
export const resolveExtractorForTest = resolveExtractor;

/**
 * PDF pipeline: Tier-0 per-page text (free) → scanned-page detection →
 * vision escalation of the scanned pages (triage: sampled; full: all,
 * budget-capped). Vision failure DEGRADES to text + warning — the money
 * already spent on nothing is zero, and partial text beats a failed
 * document (resilience.md §5 ladder); it fails the document only when
 * there is no text at all (`pdf_no_text` — the honest reason).
 */
const extractPdfDocument = async (
  input: ExtractionInput,
  opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  const tier0 = await extractPdfText(input.buffer);
  const warnings: string[] = [];
  let blocks: ExtractionBlock[] = [...tier0.blocks];
  // Pages the vision provider was actually asked to transcribe (billed) —
  // reported even when a page came back blank, so the caller's resume
  // marker does not re-escalate it forever. Stays empty when no call was
  // made or when the call failed and we degraded to text-only.
  let visionAttemptedPages: number[] = [];

  if (tier0.scannedPages.length > 0) {
    const pages =
      opts.mode === 'triage'
        ? selectTriagePages({ scannedPages: tier0.scannedPages, pageCount: tier0.pageCount })
        : tier0.scannedPages;
    try {
      const vision = await transcribePdfPages({
        pdf: input.buffer,
        pages,
        pageCount: tier0.pageCount,
        filename: input.filename,
        budget: opts.visionPageBudget ?? DEFAULT_VISION_PAGE_BUDGET,
      });
      blocks.push(...vision.blocks);
      warnings.push(...vision.warnings);
      visionAttemptedPages = vision.transcribedPages;
      if (opts.mode === 'triage' && tier0.scannedPages.length > vision.transcribedPages.length) {
        warnings.push(
          `pdf: ${tier0.scannedPages.length - vision.transcribedPages.length} scanned pages were sampled, not fully transcribed (triage)`,
        );
      }
    } catch (err) {
      // Degrade, don't destroy: text extraction already succeeded.
      const message = err instanceof Error ? err.message : String(err);
      genLog.warn(`doc:extract vision degraded file=${input.filename} reason=${message.slice(0, 200)}`);
      warnings.push('pdf: vision transcription of scanned pages failed; text-layer content only');
    }
  }

  blocks = blocks.sort((a, b) => (a.pageRange?.start ?? 0) - (b.pageRange?.start ?? 0));
  const markdown = blocksToMarkdown(blocks);
  if (!markdown.trim()) {
    throw new ExtractionError(
      'pdf_no_text',
      tier0.scannedPages.length > 0
        ? 'the PDF appears to be scanned and could not be transcribed'
        : 'the PDF contains no extractable text',
    );
  }

  return {
    markdown,
    blocks,
    pageCount: tier0.pageCount,
    charsPerPage: tier0.charsPerPage,
    scannedPages: tier0.scannedPages,
    visionAttemptedPages,
    warnings,
  };
};

/**
 * Extract one document into the stable contract. Throws
 * `ExtractionError` with an honest, category-level reason on failure.
 */
export const extractDocument = async (
  input: ExtractionInput,
  opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  if (input.kind === 'url') {
    // URL fetch is I/O through Jina — not parse-limited.
    return extractUrl(input, opts);
  }

  if (input.buffer.length === 0) {
    throw new ExtractionError('empty_file', 'the file is empty');
  }

  const extractor = resolveExtractor(input);
  if (extractor === null) {
    throw new ExtractionError('unsupported_format', `no extractor for ${input.mimeType}`);
  }

  const run = extractor === 'pdf' ? extractPdfDocument : extractor;
  const result = await parseLimit(() => run(input, opts));

  // Belt-and-braces size cap on the assembled document (per-format caps
  // exist, but the contract-level guarantee lives here).
  if (result.markdown.length > MAX_EXTRACTED_CHARS) {
    const truncated = result.markdown.slice(0, MAX_EXTRACTED_CHARS);
    return {
      ...result,
      markdown: truncated,
      warnings: [...result.warnings, `extraction: content truncated to ${MAX_EXTRACTED_CHARS} characters`],
    };
  }
  return result;
};
