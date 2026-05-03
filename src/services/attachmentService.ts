import { extractText, getDocumentProxy } from 'unpdf';
import { integrationLog } from '@lib/loggers';

/**
 * Single source of truth for extracting plain text from a learner's
 * uploaded attachment. The mentor chat path consumes the result
 * statelessly: extract → return text → client embeds in next message →
 * server forgets. We never persist the file or its extracted text;
 * keeps the data-handling story simple (no S3, no expiry, no GDPR
 * follow-on for orphan attachments) and matches the one-shot intent of
 * "explain this paper to me".
 *
 * Two extraction paths:
 *   - PDF (`application/pdf`) → unpdf, which wraps pdfjs-dist for Node.
 *     Returns concatenated page text.
 *   - Text-like (txt/md/code/json) → utf-8 decode of the buffer with a
 *     replacement-char heuristic to detect binary masquerading as text.
 *
 * Anything else is rejected by the controller before we get here. No
 * OCR, no image extraction. If a learner uploads a scanned PDF (zero
 * embedded text), we surface a clear error so they can re-upload.
 */

export type AttachmentKind = 'pdf' | 'text';

export interface AttachmentExtraction {
  kind: AttachmentKind;
  text: string;
  /** Approximate token count (chars/4). Real count comes from the LLM call. */
  approxTokens: number;
  /** Original filename for display + the markdown wrapper. */
  filename: string;
}

export type ExtractionError =
  | 'empty_file'
  | 'pdf_no_text'
  | 'pdf_parse_failed'
  | 'binary_in_text'
  | 'extraction_failed';

const MAX_OUTPUT_CHARS = 200_000; // ~50K tokens at chars/4 — safety net before the controller's token check

/**
 * Detect "binary content claiming to be text" by counting Unicode
 * replacement characters introduced by lossy utf-8 decoding. A real
 * code/text file has 0; a binary file decoded as utf-8 produces many.
 * Threshold 0.1% is well above natural noise but well below binary.
 */
const looksBinary = (decoded: string): boolean => {
  if (decoded.length === 0) return false;
  let replacementCount = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) === 0xfffd) replacementCount++;
  }
  return replacementCount / decoded.length > 0.001;
};

const decodeUtf8 = (buffer: Buffer): string => {
  // 'fatal: false' (default) replaces invalid bytes with U+FFFD so we can
  // detect them above. Strip BOM if present.
  let text = new TextDecoder('utf-8').decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
};

const extractPdf = async (buffer: Buffer): Promise<{ ok: true; text: string } | { ok: false; error: ExtractionError }> => {
  try {
    // unpdf takes a Uint8Array. Copy to ensure we don't pass a Buffer
    // pointer that downstream code might mutate or reuse.
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join('\n\n') : text;
    const trimmed = merged.trim();
    if (!trimmed) return { ok: false, error: 'pdf_no_text' };
    return { ok: true, text: trimmed };
  } catch (err) {
    integrationLog.warn(`pdf:parse fail reason=${err instanceof Error ? err.message : err}`);
    return { ok: false, error: 'pdf_parse_failed' };
  }
};

export const extractAttachmentText = async ({
  buffer,
  mimeType,
  filename,
}: {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}): Promise<{ ok: true; data: AttachmentExtraction } | { ok: false; error: ExtractionError }> => {
  if (buffer.length === 0) return { ok: false, error: 'empty_file' };

  let text: string;
  let kind: AttachmentKind;

  if (mimeType === 'application/pdf') {
    const result = await extractPdf(buffer);
    if (!result.ok) return result;
    text = result.text;
    kind = 'pdf';
  } else {
    // Treat everything else the controller approved as text.
    text = decodeUtf8(buffer);
    if (looksBinary(text)) return { ok: false, error: 'binary_in_text' };
    text = text.trim();
    if (!text) return { ok: false, error: 'empty_file' };
    kind = 'text';
  }

  // Cap the extracted text. The controller will additionally reject if
  // approxTokens crosses the per-message budget; this cap is a defense
  // for the rare case where a 9.9-MB upload distills to a 5-MB text dump.
  const truncated = text.length > MAX_OUTPUT_CHARS;
  if (truncated) text = text.slice(0, MAX_OUTPUT_CHARS);

  const approxTokens = Math.ceil(text.length / 4);

  integrationLog.info(
    `attachment:extract ok name=${filename} kind=${kind} bytesIn=${buffer.length} bytesOut=${text.length} tokens~${approxTokens}${truncated ? ' truncated' : ''}`,
  );

  return {
    ok: true,
    data: {
      kind,
      text,
      approxTokens,
      filename,
    },
  };
};
