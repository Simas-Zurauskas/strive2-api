import { parseOffice, OfficeContentNode, SupportedFileType } from 'officeparser';
import { preScanZip, ZIP_MAX_ENTRIES, ZIP_MAX_UNCOMPRESSED_BYTES } from './zipGuard';
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
 * pptx / xlsx / odt / odp / ods → officeparser AST → contract blocks.
 *
 * Zip-bomb defense is layered (plan §3.2): our central-directory
 * pre-scan gates DECLARED sizes first, then officeparser's own
 * `decompressionLimits` (same numbers) bounds ACTUAL inflated bytes
 * while it unpacks — a central directory that lies about sizes is
 * caught by the second layer.
 *
 * Blocks: slides → one `text` block per slide (headingPath "Slide N"),
 * sheets → one atomic `table` block per sheet (headingPath sheet name),
 * flat documents (odt) → heading-scoped text blocks + atomic tables.
 */

const MIME_TO_FILETYPE: Record<string, SupportedFileType> = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
};

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** Depth-first text of a node (paragraph-ish granularity). */
const nodeText = (node: OfficeContentNode): string => {
  const own = typeof node.text === 'string' ? node.text : '';
  const childText = (node.children ?? []).map(nodeText).filter(Boolean);
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'list') {
    return [own, ...childText].filter(Boolean).join(' ');
  }
  return [own, ...childText].filter(Boolean).join('\n');
};

/** Rows/cells subtree → markdown pipe table. */
const tableNodeToMarkdown = (node: OfficeContentNode): string => {
  const rows: string[][] = [];
  const collectRows = (n: OfficeContentNode) => {
    if (n.type === 'row') {
      const cells = (n.children ?? [])
        .filter((c) => c.type === 'cell')
        .map((c) => escapeCell(nodeText(c)));
      if (cells.length > 0) rows.push(cells);
      return;
    }
    for (const child of n.children ?? []) collectRows(child);
  };
  collectRows(node);
  if (rows.length === 0) return normalizeExtractedText(nodeText(node));
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const [header, ...body] = rows.map(pad);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
};

const astToBlocks = (content: OfficeContentNode[]): ExtractionBlock[] => {
  const blocks: ExtractionBlock[] = [];
  const headingStack: string[] = [];
  let pending: string[] = [];

  const currentPath = () => headingStack.filter(Boolean);

  const flushText = (pathOverride?: string[]) => {
    const markdown = normalizeExtractedText(pending.join('\n\n'));
    pending = [];
    if (!markdown) return;
    blocks.push({ type: 'text', markdown, headingPath: pathOverride ?? currentPath() });
  };

  for (const node of content) {
    if (node.type === 'slide') {
      flushText();
      const slideNumber = (node.metadata as { slideNumber?: number } | undefined)?.slideNumber;
      const label = `Slide ${slideNumber ?? blocks.length + 1}`;
      const markdown = normalizeExtractedText(nodeText(node));
      if (markdown) blocks.push({ type: 'text', markdown, headingPath: [label] });
      continue;
    }
    if (node.type === 'sheet') {
      flushText();
      const sheetName = (node.metadata as { sheetName?: string } | undefined)?.sheetName;
      const markdown = normalizeExtractedText(tableNodeToMarkdown(node));
      if (markdown) blocks.push({ type: 'table', markdown, headingPath: [sheetName ?? 'Sheet'] });
      continue;
    }
    if (node.type === 'table') {
      flushText();
      const markdown = normalizeExtractedText(tableNodeToMarkdown(node));
      if (markdown) blocks.push({ type: 'table', markdown, headingPath: currentPath() });
      continue;
    }
    if (node.type === 'heading') {
      flushText();
      const level = Math.max(1, (node.metadata as { level?: number } | undefined)?.level ?? 1);
      const headingText = normalizeExtractedText(nodeText(node));
      headingStack.length = level - 1;
      headingStack[level - 1] = headingText;
      if (headingText) pending.push(`${'#'.repeat(level)} ${headingText}`);
      continue;
    }
    const text = nodeText(node);
    if (text.trim()) pending.push(text);
  }
  flushText();
  return blocks;
};

export const extractOffice = async (
  input: ExtractionInput,
  _opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  // Layer 1: declared-size gate (throws zip_bomb / zip_invalid).
  preScanZip(input.buffer);

  const fileType = MIME_TO_FILETYPE[input.mimeType] ?? null;

  let content: OfficeContentNode[];
  const warnings: string[] = [];
  try {
    const ast = await parseOffice(input.buffer, {
      fileType,
      // Layer 2: officeparser enforces these on ACTUAL inflated bytes.
      decompressionLimits: {
        maxUncompressedBytes: ZIP_MAX_UNCOMPRESSED_BYTES,
        maxZipEntries: ZIP_MAX_ENTRIES,
      },
      extractAttachments: false,
      ocr: false,
    });
    content = ast.content;
    for (const issue of ast.warnings ?? []) {
      if (issue.type === 'warning') warnings.push(`office: ${String(issue.message).slice(0, 200)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/zip.*(size|entry|limit)/i.test(message)) {
      throw new ExtractionError('zip_bomb', 'archive exceeds decompression limits');
    }
    throw new ExtractionError('office_parse_failed', `could not read document structure: ${message.slice(0, 200)}`);
  }

  const blocks = astToBlocks(content);
  if (blocks.length === 0) {
    throw new ExtractionError('office_parse_failed', 'document contains no extractable text');
  }

  return {
    markdown: blocksToMarkdown(blocks),
    blocks,
    warnings,
  };
};
