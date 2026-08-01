import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { ExtractionBlock, normalizeExtractedText } from './types';

/**
 * Shared HTML → ExtractionBlock[] walker, used by the docx (mammoth
 * emits HTML), html (readability emits HTML) and epub (spine XHTML)
 * paths.
 *
 * Hardened DOM by construction: linkedom performs NO script execution
 * and NO subresource fetching — there is no `runScripts` to forget and
 * no resource loader to disable (the html.test fixture pins this).
 * `<script>/<style>/<iframe>` etc. are additionally dropped from output,
 * and `<img>` tags are stripped entirely — images carry no extractable
 * text, and dropping them keeps attacker-chosen URLs out of the corpus
 * (figures enter through the vision path only).
 *
 * Block strategy: walk top-level flow; `h1..h6` update the headingPath
 * breadcrumb and flush; `<table>` becomes an atomic `table` block
 * (markdown pipe table — the Topo-RAG "keep tables whole" rule);
 * everything else accumulates into `text` blocks converted by turndown.
 */

// Elements whose content must never reach the corpus.
const DROP_SELECTOR = 'script, style, noscript, iframe, object, embed, svg, img, video, audio, form, button';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.remove(['script', 'style']);

type DomElement = {
  tagName?: string;
  textContent: string | null;
  outerHTML?: string;
  children: ArrayLike<DomElement>;
  querySelectorAll: (sel: string) => ArrayLike<DomElement>;
  removeAttribute?: (name: string) => void;
  remove?: () => void;
};

const escapeCell = (value: string): string =>
  value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** `<table>` element → GitHub markdown pipe table. */
export const tableElementToMarkdown = (table: DomElement): string => {
  const rows = Array.from(table.querySelectorAll('tr') as ArrayLike<DomElement>);
  if (rows.length === 0) return '';
  const cellsOf = (row: DomElement): string[] =>
    Array.from(row.querySelectorAll('th, td') as ArrayLike<DomElement>).map((c) =>
      escapeCell(c.textContent ?? ''),
    );
  const header = cellsOf(rows[0]);
  if (header.length === 0) return '';
  const lines: string[] = [];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows.slice(1)) {
    const cells = cellsOf(row);
    if (cells.length === 0) continue;
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
};

const HEADING_RE = /^h([1-6])$/i;

export interface HtmlToBlocksOptions {
  /** Prefix pushed under every headingPath (e.g. the epub chapter title). */
  rootHeadingPath?: string[];
  /** Attached to every produced block (e.g. an epub chapter's page-less source). */
  pageRange?: { start: number; end: number };
}

/**
 * Convert an HTML string into contract blocks. Never throws on weird
 * markup — worst case it returns an empty array (caller decides what an
 * empty document means).
 */
export const htmlToBlocks = (html: string, options: HtmlToBlocksOptions = {}): ExtractionBlock[] => {
  const rootPath = options.rootHeadingPath ?? [];
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.querySelector('body') as unknown as DomElement | null;
  if (!body) return [];

  for (const el of Array.from(body.querySelectorAll(DROP_SELECTOR) as ArrayLike<DomElement>)) {
    el.remove?.();
  }

  const blocks: ExtractionBlock[] = [];
  // headingPath per level: headingStack[0] = current h1, [1] = h2, …
  const headingStack: string[] = [];
  let pendingHtml: string[] = [];

  const currentPath = (): string[] => {
    const path = [...rootPath, ...headingStack.filter(Boolean)];
    // Collapse consecutive duplicates (epub chapter title == its own h1).
    return path.filter((entry, i) => entry !== path[i - 1]);
  };

  const flushText = () => {
    if (pendingHtml.length === 0) return;
    const markdown = normalizeExtractedText(turndown.turndown(pendingHtml.join('\n')));
    pendingHtml = [];
    if (!markdown) return;
    blocks.push({
      type: 'text',
      markdown,
      headingPath: currentPath(),
      ...(options.pageRange ? { pageRange: options.pageRange } : {}),
    });
  };

  const walk = (el: DomElement) => {
    const tag = (el.tagName ?? '').toLowerCase();
    const headingMatch = tag.match(HEADING_RE);
    if (headingMatch) {
      flushText();
      const level = Number(headingMatch[1]);
      headingStack.length = level - 1;
      headingStack[level - 1] = normalizeExtractedText(el.textContent ?? '');
      // The heading also opens the next block's markdown, so heading
      // text survives in the document flow (not only in headingPath).
      if (el.outerHTML) pendingHtml.push(el.outerHTML);
      return;
    }
    if (tag === 'table') {
      flushText();
      const markdown = normalizeExtractedText(tableElementToMarkdown(el));
      if (markdown) {
        blocks.push({
          type: 'table',
          markdown,
          headingPath: currentPath(),
          ...(options.pageRange ? { pageRange: options.pageRange } : {}),
        });
      }
      return;
    }
    // Containers (div/section/article/main…) descend so headings and
    // tables nested one level down still structure the output.
    if (['div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'body'].includes(tag)) {
      const children = Array.from(el.children);
      if (children.length > 0) {
        for (const child of children) walk(child);
        return;
      }
    }
    if (el.outerHTML) pendingHtml.push(el.outerHTML);
  };

  for (const child of Array.from(body.children)) walk(child);
  flushText();
  return blocks;
};
