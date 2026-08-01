import path from 'node:path';
import { preScanZip, readZipEntryByName, ZipScan } from './zipGuard';
import { htmlToBlocks } from './htmlBlocks';
import {
  ExtractionBlock,
  ExtractionError,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
  blocksToMarkdown,
  normalizeExtractedText,
} from './types';

/**
 * EPUB = a zip of XHTML. Reader: the hand-rolled bounded zip reader
 * (same 200 MB / 5000-entry gate as docx, plus actual-inflated-bytes
 * bounds) → OPF spine for chapter order → each chapter through the
 * shared htmlToBlocks path with the chapter title as the headingPath
 * root. No new dependency (plan Phase 2).
 *
 * The container/OPF parsing is regex-based on purpose: we only need
 * `rootfile@full-path`, manifest `id→href`, and spine `idref` order —
 * a full XML parser adds surface without adding correctness for these
 * three attribute lookups.
 */

const attr = (tag: string, name: string): string | null => {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`)) ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`));
  return match ? match[1] : null;
};

const resolveHref = (opfDir: string, href: string): string =>
  path.posix.normalize(path.posix.join(opfDir, decodeURIComponent(href)));

const readOpf = (buffer: Buffer, scan: ZipScan): { opfXml: string; opfDir: string } => {
  const containerXml = readZipEntryByName(buffer, scan, 'META-INF/container.xml')?.toString('utf-8');
  if (!containerXml) throw new ExtractionError('epub_parse_failed', 'missing META-INF/container.xml');
  const rootfileTag = containerXml.match(/<rootfile\b[^>]*>/)?.[0];
  const opfPath = rootfileTag ? attr(rootfileTag, 'full-path') : null;
  if (!opfPath) throw new ExtractionError('epub_parse_failed', 'container.xml has no rootfile path');
  const opfXml = readZipEntryByName(buffer, scan, opfPath)?.toString('utf-8');
  if (!opfXml) throw new ExtractionError('epub_parse_failed', 'OPF package document missing');
  return { opfXml, opfDir: path.posix.dirname(opfPath) };
};

export const extractEpub = async (
  input: ExtractionInput,
  _opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  const scan = preScanZip(input.buffer); // throws zip_bomb / zip_invalid
  const { opfXml, opfDir } = readOpf(input.buffer, scan);

  // manifest: id → href (xhtml items only matter for the spine walk).
  const manifest = new Map<string, string>();
  for (const itemTag of opfXml.match(/<item\b[^>]*>/g) ?? []) {
    const id = attr(itemTag, 'id');
    const href = attr(itemTag, 'href');
    if (id && href) manifest.set(id, href);
  }

  const spineIds = (opfXml.match(/<itemref\b[^>]*>/g) ?? [])
    .map((tag) => attr(tag, 'idref'))
    .filter((id): id is string => Boolean(id));

  if (spineIds.length === 0) {
    throw new ExtractionError('epub_parse_failed', 'OPF spine lists no readable chapters');
  }

  const warnings: string[] = [];
  const blocks: ExtractionBlock[] = [];

  spineIds.forEach((id, index) => {
    const href = manifest.get(id);
    if (!href) {
      warnings.push(`epub: spine item ${index + 1} missing from manifest — skipped`);
      return;
    }
    const entryName = resolveHref(opfDir, href);
    const xhtml = readZipEntryByName(input.buffer, scan, entryName)?.toString('utf-8');
    if (!xhtml) {
      warnings.push(`epub: chapter file ${index + 1} missing from archive — skipped`);
      return;
    }
    // Chapter title: first h1/h2, else <title>, else positional.
    const title = normalizeExtractedText(
      xhtml.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i)?.[1]?.replace(/<[^>]+>/g, '') ??
        xhtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
        `Chapter ${index + 1}`,
    );
    const bodyHtml = xhtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? xhtml;
    blocks.push(...htmlToBlocks(bodyHtml, { rootHeadingPath: [title] }));
  });

  if (blocks.length === 0) {
    throw new ExtractionError('epub_parse_failed', 'no readable chapter content');
  }

  return {
    markdown: blocksToMarkdown(blocks),
    blocks,
    warnings,
  };
};
