import {
  ExtractionBlock,
  ExtractionError,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
  MAX_EXTRACTED_CHARS,
  blocksToMarkdown,
  normalizeExtractedText,
} from './types';

/**
 * txt / md passthrough. Decoding heuristics mirror the precedent in
 * `attachmentService.ts` (U+FFFD replacement-density check for binary
 * masquerading as text) — reimplemented here so that service stays
 * byte-for-byte untouched (Phase 2 hard rule).
 *
 * Markdown additionally splits on ATX headings so blocks carry a real
 * headingPath; plain text stays one block.
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
  let text = new TextDecoder('utf-8').decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
};

const markdownToBlocks = (markdown: string): ExtractionBlock[] => {
  const blocks: ExtractionBlock[] = [];
  const headingStack: string[] = [];
  let pending: string[] = [];

  const flush = () => {
    const text = normalizeExtractedText(pending.join('\n'));
    pending = [];
    if (!text) return;
    blocks.push({ type: 'text', markdown: text, headingPath: headingStack.filter(Boolean) });
  };

  for (const line of markdown.split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      headingStack.length = level - 1;
      headingStack[level - 1] = normalizeExtractedText(heading[2]);
      pending.push(line); // heading text stays in the markdown flow too
      continue;
    }
    pending.push(line);
  }
  flush();
  return blocks.map((b) => ({ ...b, headingPath: [...b.headingPath] }));
};

export const extractPlainText = async (
  input: ExtractionInput,
  _opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  const decoded = decodeUtf8(input.buffer);
  if (looksBinary(decoded)) {
    throw new ExtractionError('binary_in_text', 'binary content in a text file');
  }

  const warnings: string[] = [];
  let text = decoded;
  if (text.length > MAX_EXTRACTED_CHARS) {
    text = text.slice(0, MAX_EXTRACTED_CHARS);
    warnings.push(`text: content truncated to ${MAX_EXTRACTED_CHARS} characters`);
  }

  const isMarkdown = input.mimeType === 'text/markdown' || /\.(md|markdown)$/i.test(input.filename);
  const blocks = isMarkdown
    ? markdownToBlocks(text)
    : (() => {
        const normalized = normalizeExtractedText(text);
        return normalized
          ? [{ type: 'text' as const, markdown: normalized, headingPath: [] as string[] }]
          : [];
      })();

  if (blocks.length === 0) {
    throw new ExtractionError('empty_file', 'no text content');
  }

  return {
    markdown: blocksToMarkdown(blocks),
    blocks,
    warnings,
  };
};
