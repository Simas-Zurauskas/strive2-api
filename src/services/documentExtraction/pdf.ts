import { extractText, getDocumentProxy } from 'unpdf';
import {
  ExtractionBlock,
  ExtractionError,
  SCANNED_PAGE_CHAR_THRESHOLD,
  normalizeExtractedText,
} from './types';

/**
 * Tier-0 PDF text extraction — unpdf (pdf.js), same engine as
 * `attachmentService` but PER PAGE, because chars-per-page is the
 * scanned-page escalation signal (research §5: <100 chars/page ⇒
 * scanned).
 *
 * Vision escalation is deliberately NOT called from here: this module
 * only reports WHICH pages need it (`scannedPages`); the router decides
 * whether/how to escalate (triage sampling vs full, budget) via
 * `visionEscalation.ts`.
 */

export interface PdfTextExtraction {
  blocks: ExtractionBlock[];
  pageCount: number;
  charsPerPage: number[];
  /** 1-based page numbers below the scanned threshold. */
  scannedPages: number[];
}

const isPasswordError = (err: unknown): boolean => {
  const name = (err as { name?: string })?.name ?? '';
  const message = err instanceof Error ? err.message : String(err);
  return name === 'PasswordException' || /password/i.test(message);
};

export const extractPdfText = async (buffer: Buffer): Promise<PdfTextExtraction> => {
  let pages: string[];
  try {
    // Copy so downstream can't mutate the caller's buffer (attachmentService precedent).
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    pages = Array.isArray(text) ? text : [String(text)];
    if (pages.length < totalPages) {
      pages = [...pages, ...Array(totalPages - pages.length).fill('')];
    }
  } catch (err) {
    if (isPasswordError(err)) {
      throw new ExtractionError('pdf_password_protected', 'the PDF is password-protected');
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractionError('pdf_parse_failed', `could not parse the PDF: ${message.slice(0, 200)}`);
  }

  const charsPerPage: number[] = [];
  const scannedPages: number[] = [];
  const blocks: ExtractionBlock[] = [];

  pages.forEach((raw, index) => {
    const pageNumber = index + 1;
    const text = normalizeExtractedText(raw ?? '');
    charsPerPage.push(text.length);
    if (text.length < SCANNED_PAGE_CHAR_THRESHOLD) {
      scannedPages.push(pageNumber);
      return;
    }
    blocks.push({
      type: 'text',
      markdown: text,
      pageRange: { start: pageNumber, end: pageNumber },
      headingPath: [],
    });
  });

  return { blocks, pageCount: pages.length, charsPerPage, scannedPages };
};
