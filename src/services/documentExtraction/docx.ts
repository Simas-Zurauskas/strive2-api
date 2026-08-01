import mammoth from 'mammoth';
import { preScanZip } from './zipGuard';
import { htmlToBlocks } from './htmlBlocks';
import {
  ExtractionError,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
  blocksToMarkdown,
} from './types';

/**
 * DOCX → mammoth (semantic HTML: headings/lists/tables preserved) →
 * shared htmlToBlocks → markdown. Tables come through as atomic `table`
 * blocks.
 *
 * mammoth exposes no decompression cap of its own, so the hand-rolled
 * zip central-directory pre-scan (200 MB declared / 5000 entries) gates
 * every buffer BEFORE mammoth touches it (plan §3.2 hardening).
 */
export const extractDocx = async (
  input: ExtractionInput,
  _opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  // Throws zip_bomb / zip_invalid — deliberately before mammoth.
  preScanZip(input.buffer);

  let html: string;
  const warnings: string[] = [];
  try {
    const result = await mammoth.convertToHtml({ buffer: input.buffer });
    html = result.value;
    for (const message of result.messages) {
      if (message.type === 'warning') warnings.push(`docx: ${message.message}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractionError('docx_parse_failed', `could not read docx structure: ${message.slice(0, 200)}`);
  }

  const blocks = htmlToBlocks(html);
  if (blocks.length === 0) {
    throw new ExtractionError('docx_parse_failed', 'document contains no extractable text');
  }

  return {
    markdown: blocksToMarkdown(blocks),
    blocks,
    warnings,
  };
};
