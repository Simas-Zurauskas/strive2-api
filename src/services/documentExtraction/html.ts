import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { htmlToBlocks } from './htmlBlocks';
import {
  ExtractionError,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
  blocksToMarkdown,
} from './types';

/**
 * HTML → @mozilla/readability (boilerplate removal) on a hardened DOM →
 * shared htmlToBlocks → markdown.
 *
 * DOM choice (plan Phase 2 decision): **linkedom**, not jsdom — it has
 * no script engine and no resource loader at all, so "runScripts unset"
 * is a structural property rather than a configuration to keep correct.
 * html.test.ts pins the no-execution / no-egress behavior with a
 * fixture containing `<script>` and an `<img src="http://169.254.…">`.
 *
 * Readability failure is non-fatal: article pages get boilerplate
 * removal, everything else falls back to a straight body walk.
 */
export const extractHtml = async (
  input: ExtractionInput,
  _opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  const raw = input.buffer.toString('utf-8');
  const warnings: string[] = [];

  let articleHtml: string | null = null;
  try {
    const { document } = parseHTML(raw);
    // Readability mutates its document — parse a fresh copy for it.
    const reader = new Readability(document as unknown as Document, { charThreshold: 250 });
    const article = reader.parse();
    if (article?.content && (article.textContent ?? '').trim().length > 0) {
      articleHtml = article.content;
    }
  } catch {
    warnings.push('html: readability failed; extracted the full page body instead');
  }

  let blocks = articleHtml ? htmlToBlocks(articleHtml) : [];
  if (blocks.length === 0) {
    // Fallback: whole body (readability rejects short/non-article pages).
    const { document } = parseHTML(raw);
    const body = document.querySelector('body');
    blocks = htmlToBlocks(body ? (body as unknown as { innerHTML: string }).innerHTML : raw);
  }

  if (blocks.length === 0) {
    throw new ExtractionError('html_parse_failed', 'page contains no extractable text');
  }

  return {
    markdown: blocksToMarkdown(blocks),
    blocks,
    warnings,
  };
};
