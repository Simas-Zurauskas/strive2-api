/**
 * Lesson markdown → pdfmake content.
 *
 * Deliberately narrow: it covers what the generator actually emits, not
 * CommonMark. The app renders these blocks with `react-markdown` +
 * `remark-gfm` + `remark-math`, so the subset is headings, paragraphs,
 * bold/italic, inline code, links, bullet and ordered lists (nested),
 * blockquotes, fenced code, horizontal rules, GFM pipe tables, and maths.
 *
 * Tables are in the subset because they are not rare: 35 pipe tables across
 * production `section` and `exercise` blocks, and three of the nine domain
 * prompt branches explicitly instruct the model to produce them
 * (`lib/ai/agents/lessonGeneration/prompts.ts:92,94,95`). Rendered as
 * literal `| Option | Cost |` text they would be unreadable.
 *
 * Anything outside the subset falls through as plain text — it degrades,
 * it never throws.
 */

import type { Content, ContentTable, TableCell } from 'pdfmake/interfaces';
import { displayMathRe, inlineMathRe } from '@lib/latexSanitizer';
import { COLORS, CONTENT_WIDTH, FONT_SIZE, LINE_HEIGHT } from './theme';
import { inlineMathToText } from './inlineMath';
import { renderMath } from './math';

// ── inline ─────────────────────────────────────────────────

type Inline = { text: string; bold?: boolean; italics?: boolean; link?: string; style?: string };

/**
 * Schemes allowed to become a clickable PDF link annotation.
 *
 * Every href in a lesson is LLM-generated — markdown links, the `links`
 * block, and MathJax's `\href` are all reachable from model output. PDF
 * readers generally refuse `javascript:` URI actions, but nothing in this
 * pipeline was deciding that, and "the reader will probably save us" is not
 * a control. An unsupported scheme keeps its label and loses only the link.
 */
export const isSafeLinkHref = (href: string): boolean => /^(https?:|mailto:)/i.test(href.trim());

/**
 * Split a paragraph into styled runs. Order matters: links first (their
 * label can contain emphasis markers), then bold before italic so `**` is
 * not eaten by the single-`*` rule.
 */
const inlineRuns = (input: string): Inline[] => {
  const runs: Inline[] = [];
  const pattern =
    /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|(?<!\*)\*([^*\n]+)\*(?!\*)|_([^_\n]+)_|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(input)) !== null) {
    if (m.index > last) runs.push({ text: input.slice(last, m.index) });
    if (m[1] !== undefined) {
      const href = m[2];
      // Label kept either way; only the annotation is withheld.
      runs.push(isSafeLinkHref(href) ? { text: m[1], link: href, style: 'link' } : { text: m[1] });
    }
    else if (m[3] !== undefined) runs.push({ text: m[3], bold: true });
    else if (m[4] !== undefined) runs.push({ text: m[4], bold: true });
    else if (m[5] !== undefined) runs.push({ text: m[5], italics: true });
    else if (m[6] !== undefined) runs.push({ text: m[6], italics: true });
    else if (m[7] !== undefined) runs.push({ text: m[7], style: 'code' });
    last = pattern.lastIndex;
  }
  if (last < input.length) runs.push({ text: input.slice(last) });
  return runs.length > 0 ? runs : [{ text: input }];
};

/**
 * Text runs for a string that may contain inline maths.
 *
 * Inline maths is typeset as Unicode text, NOT as an `{svg}` node. pdfmake
 * has no inline graphic: an svg inside a `text` array is not a text leaf,
 * so `docMeasure` drops it silently and the expression vanishes from the
 * page with no error. See `inlineMath.ts` for the measurement.
 *
 * An expression Unicode cannot represent — a fraction, a radical, a matrix
 * — is marked `faithful: false` by the converter and rendered in italic as
 * its source rather than as something subtly wrong. Those belong in `$$…$$`
 * anyway, which still gets the full MathJax SVG.
 */
const inlineRunsWithMath = (input: string): Inline[] => {
  const re = inlineMathRe();
  const runs: Inline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.index > last) runs.push(...inlineRuns(input.slice(last, m.index)));
    const converted = inlineMathToText(m[1]);
    runs.push({ text: converted.text, italics: !converted.faithful, style: 'mathInline' });
    last = re.lastIndex;
  }
  if (runs.length === 0) return inlineRuns(input);
  if (last < input.length) runs.push(...inlineRuns(input.slice(last)));
  return runs;
};

/** A body paragraph, with any inline maths already resolved to text. */
const inlineContent = (input: string): Content =>
  ({ text: inlineRunsWithMath(input), style: 'body' }) as Content;

// ── tables ─────────────────────────────────────────────────

/**
 * A GFM delimiter row. It must contain at least one `|`, which is what
 * separates it from a plain `---` horizontal rule — otherwise a paragraph
 * that merely mentions a pipe (`Use the pipe | operator here.`) followed by
 * a rule is parsed as a two-column table and the rule disappears.
 */
const TABLE_DELIM = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const isTableDelimiter = (line: string): boolean => line.includes('|') && TABLE_DELIM.test(line);

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const alignmentsOf = (delim: string): ('left' | 'center' | 'right')[] =>
  splitRow(delim).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
  );

const buildTable = (rows: string[][], aligns: ('left' | 'center' | 'right')[]): ContentTable => {
  const [head, ...body] = rows;
  // The same inline pipeline as a paragraph, so `$1 + 2 = 3$` in a cell is
  // typeset rather than printed as source. Production tables really do
  // carry maths — the Lithuanian arithmetic exercise is one.
  const cell = (text: string, i: number, isHeader: boolean): TableCell =>
    ({
      text: inlineRunsWithMath(text),
      style: isHeader ? 'tableHead' : 'tableCell',
      alignment: aligns[i] ?? 'left',
    }) as TableCell;

  return {
    table: {
      headerRows: 1,
      widths: head.map(() => '*'),
      body: [
        head.map((c, i) => cell(c, i, true)),
        ...body.map((r) => head.map((_, i) => cell(r[i] ?? '', i, false))),
      ],
    },
    layout: {
      hLineWidth: (i: number) => (i === 0 || i === 1 ? 0.75 : 0.4),
      vLineWidth: () => 0,
      hLineColor: (i: number) => (i === 1 ? COLORS.muted : COLORS.border),
      paddingTop: () => 4,
      paddingBottom: () => 4,
      paddingLeft: () => 0,
      paddingRight: () => 8,
    },
    margin: [0, 5, 0, 10],
  } as ContentTable;
};

// ── block level ────────────────────────────────────────────

/**
 * Nesting depth beyond which further indentation is flattened rather than
 * recursed into.
 *
 * The recursion re-joins and re-splits the remaining tail at every level,
 * so it is O(n^3) in depth. `blockSchema.content` declares a 50 000-char
 * cap, but the generation path writes via `findOneAndUpdate` WITHOUT
 * `runValidators` (`services/jobRunner.ts:416-430`), so that cap is not
 * actually enforced and a pathological LLM block can reach thousands of
 * levels — measured: ~1.5 s at 800, and a V8 heap abort at 3000, which
 * takes the whole single-instance process down rather than throwing
 * something catchable.
 *
 * Real lesson markdown never nests past three or four. Twelve is far past
 * anything legitimate and cheap to enforce.
 */
const MAX_LIST_NESTING = 12;

/**
 * Build a list, keeping each item's sub-list attached to THAT item.
 *
 * The obvious implementation — collect every indented line in the list into
 * one bucket and emit it after the outer list — silently relocates content:
 *
 *   - Step 1 / (indented) detail A / - Step 2 / (indented) detail B / - Step 3
 *
 * rendered as `Step 1, Step 2, Step 3, detail A, detail B`, with both
 * details attributed to the last step. In a procedural lesson that is not a
 * cosmetic problem; it is wrong instructions.
 *
 * So the walk is per item: each item owns the lines indented beneath it,
 * and those recurse into a nested list inside that item's own content.
 */
const buildList = (lines: string[], depth: number): Content => {
  const marker = /^(\s*)(?:[-*+]|\d+\.)\s+/;
  const first = marker.exec(lines[0] ?? '');
  const ordered = /^\s*\d+\./.test(lines[0] ?? '');
  const baseIndent = first ? first[1].length : 0;

  const items: Content[] = [];
  let currentText: string[] = [];
  let currentChildren: string[] = [];

  const flush = () => {
    if (currentText.length === 0 && currentChildren.length === 0) return;

    // Split the indented block into the LEADING continuation lines — which
    // belong to this item's own paragraph — and the marker-led remainder,
    // which is a real sub-list.
    //
    // Recursing on the whole block is what an earlier version did, and it
    // did not terminate on its own: a child block whose first line has no
    // marker (`- Step 1` / `  detail A`, or an indented code fence) made
    // the recursive call compute `baseIndent = 0`, push the same line back
    // into its own children, and repeat — bottoming out only on
    // MAX_LIST_NESTING, after emitting 13 nested lists and 12 empty
    // bullets for two lines of ordinary markdown.
    const firstMarker = currentChildren.findIndex((l) => marker.test(l));
    const continuation = firstMarker === -1 ? currentChildren : currentChildren.slice(0, firstMarker);
    const sublist = firstMarker === -1 ? [] : currentChildren.slice(firstMarker);

    // The continuation is marker-free by construction, so running it through
    // the full block converter cannot recurse back into a list — and it is
    // what stops an indented code fence being joined into the prose with
    // spaces, which destroyed its indentation and printed stray backticks.
    const hasBlockConstruct = continuation.some((l) => /^\s*(?:```|\||>|#{1,6}\s)/.test(l));
    const ownParts: Content[] = [inlineContent(currentText.join(' '))];
    if (continuation.length > 0) {
      if (hasBlockConstruct) {
        // Dedent by the list indent so fences and tables parse at column 0.
        const dedent = Math.min(...continuation.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
        ownParts.push(...markdownToContent(continuation.map((l) => l.slice(dedent)).join('\n'), depth + 1));
      } else {
        ownParts[0] = inlineContent([...currentText, ...continuation.map((l) => l.trim())].join(' '));
      }
    }
    const own: Content = ownParts.length === 1 ? ownParts[0] : ({ stack: ownParts } as Content);

    if (sublist.length > 0 && depth < MAX_LIST_NESTING) {
      items.push({ stack: [own, buildList(sublist, depth + 1)] } as Content);
    } else if (sublist.length > 0) {
      // Past any plausible nesting — keep the content, stop recursing.
      items.push({ stack: [own, inlineContent(sublist.map((l) => l.trim()).join(' '))] } as Content);
    } else {
      items.push(own);
    }
    currentText = [];
    currentChildren = [];
  };

  for (const line of lines) {
    const m = marker.exec(line);
    const indent = line.length - line.trimStart().length;

    if (m && indent <= baseIndent) {
      flush();
      currentText = [line.replace(marker, '')];
    } else if (m || indent > baseIndent) {
      // A deeper bullet, or a lazy continuation line — both belong to the
      // item currently being built.
      currentChildren.push(line);
    } else {
      currentText.push(line.trim());
    }
  }
  flush();

  const key = ordered ? 'ol' : 'ul';
  return { [key]: items, style: 'body', margin: [0, 0, 0, 6] } as unknown as Content;
};

/**
 * Convert a markdown string to pdfmake content nodes.
 */


export const markdownToContent = (markdown: string, depth = 0): Content[] => {
  const out: Content[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  const paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ').trim();
    paragraph.length = 0;
    if (!text) return;

    // Display maths owns its own line(s); split the paragraph around it.
    const re = displayMathRe();
    let last = 0;
    let m: RegExpExecArray | null;
    let found = false;
    while ((m = re.exec(text)) !== null) {
      found = true;
      const before = text.slice(last, m.index).trim();
      if (before) out.push(inlineContent(before));
      const rendered = renderMath({ tex: m[1], display: true });
      out.push(
        rendered
          ? ({
              svg: rendered.svg,
              width: rendered.width,
              height: rendered.height,
              alignment: 'center',
              margin: [0, 7, 0, 8],
            } as Content)
          : ({ text: m[1], style: 'mathFallback' } as Content),
      );
      last = re.lastIndex;
    }
    if (!found) {
      out.push(inlineContent(text));
      return;
    }
    const tail = text.slice(last).trim();
    if (tail) out.push(inlineContent(tail));
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      i++;
      continue;
    }

    // Fenced code
    if (/^```/.test(trimmed)) {
      flushParagraph();
      const lang = trimmed.replace(/^```/, '').trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i]), i++;
      i++; // closing fence
      out.push(codeBlockContent(body.join('\n'), lang));
      continue;
    }

    // ATX heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push({
        text: heading[2].replace(/\s*#+\s*$/, ''),
        style: level <= 2 ? 'h2' : 'h3',
      } as Content);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ''))) {
      flushParagraph();
      out.push({
        canvas: [
          { type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: COLORS.border },
        ],
        margin: [0, 7, 0, 10],
      } as Content);
      i++;
      continue;
    }

    // GFM table — a header row followed by a delimiter row
    if (trimmed.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      flushParagraph();
      const aligns = alignmentsOf(lines[i + 1]);
      const rows: string[][] = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(buildTable(rows, aligns));
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push({
        text: inlineRunsWithMath(body.join(' ')),
        style: 'quote',
        margin: [12, 4, 0, 8],
      } as Content);
      continue;
    }

    // Lists — collect the whole list (items plus everything indented under
    // them) and hand it to `buildList`, which preserves item ownership.
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph();
      const baseIndent = line.length - line.trimStart().length;
      const collected: string[] = [];
      // A non-indented, non-marker line directly under an item is a LAZY
      // CONTINUATION in markdown and belongs to that item — breaking the
      // list there splits it into two, and pdfmake restarts an `ol` at 1,
      // so `1. one / two continues / 2. three` printed as "1, 1".
      // Only a blank line or a genuine block-level construct ends the list.
      const ENDS_LIST = /^\s*(?:#{1,6}\s|```|>|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/;
      const ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;
      while (i < lines.length) {
        const l = lines[i];

        // A blank line does NOT necessarily end the list. Markdown calls a
        // list with blank lines between its items "loose", and it is still
        // one list — but ending collection here emits a second `ol`, and
        // pdfmake starts every `ol` at 1 (`docMeasure.js` defaults
        // `node.start`). A numbered procedure then reads "1. … 1. … 1.".
        // 58 of 2358 production blocks contain a loose ordered list.
        if (!l.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = lines[j];
          const continuesList =
            next !== undefined &&
            ITEM.test(next) &&
            next.length - next.trimStart().length <= baseIndent;
          if (!continuesList) break;
          i = j;
          continue;
        }

        const isItem = ITEM.test(l);
        const indent = l.length - l.trimStart().length;
        if (!isItem && indent <= baseIndent && ENDS_LIST.test(l)) break;
        collected.push(l);
        i++;
      }
      out.push(buildList(collected, 0));
      continue;
    }

    paragraph.push(trimmed);
    i++;
  }

  flushParagraph();
  return out;
};

/**
 * A code block: monospaced on a tinted ground with a language label. No
 * syntax colouring — the requirement asks for a document that is easy to
 * read, and a printed page of highlighted tokens is louder than the prose
 * around it.
 */
export const codeBlockContent = (code: string, language?: string): Content =>
  ({
    table: {
      widths: ['*'],
      body: [
        [
          {
            stack: [
              ...(language
                ? [{ text: language.toUpperCase(), style: 'codeLang' } as Content]
                : []),
              {
                text: code.replace(/\s+$/, ''),
                style: 'codeBody',
                // pdfmake trims leading whitespace on every line by default,
                // which silently destroys the indentation of exactly the
                // languages that need it — Python is the commonest one in
                // these lessons. Monospace without this is only half the fix.
                preserveLeadingSpaces: true,
              } as Content,
            ],
            fillColor: '#f5f3f0',
            margin: [9, 7, 9, 7],
          },
        ],
      ],
    },
    layout: 'noBorders',
    margin: [0, 5, 0, 9],
  }) as Content;

/** Styles the converter's output depends on. Merged into the document. */
export const MARKDOWN_STYLES = {
  body: { fontSize: FONT_SIZE.body, color: COLORS.foreground, lineHeight: LINE_HEIGHT, margin: [0, 0, 0, 7] },
  h2: { font: 'Newsreader', fontSize: FONT_SIZE.h2, color: COLORS.foreground, margin: [0, 12, 0, 5] },
  h3: { font: 'Newsreader', fontSize: FONT_SIZE.body + 1, color: COLORS.foreground, margin: [0, 9, 0, 4] },
  link: { color: COLORS.accent, decoration: 'underline' as const },
  code: { font: 'JetBrainsMono', fontSize: FONT_SIZE.body - 0.7, color: COLORS.goldText },
  codeBody: { font: 'JetBrainsMono', fontSize: FONT_SIZE.small - 0.3, color: COLORS.foreground, lineHeight: 1.35 },
  codeLang: { fontSize: FONT_SIZE.tiny - 1, color: COLORS.muted, margin: [0, 0, 0, 4], characterSpacing: 1 },
  quote: { fontSize: FONT_SIZE.body, italics: true, color: COLORS.muted, lineHeight: LINE_HEIGHT },
  tableHead: { fontSize: FONT_SIZE.small, bold: true, color: COLORS.foreground },
  tableCell: { fontSize: FONT_SIZE.small, color: COLORS.foreground, lineHeight: 1.35 },
  mathFallback: { fontSize: FONT_SIZE.small, italics: true, color: COLORS.muted, alignment: 'center' as const },
  // Inter, deliberately — the body face. It is the widest-covering of the
  // three vendored faces for mathematical Unicode, and `inlineMath.ts`
  // checks every substitution against it before emitting one. Newsreader
  // was used here once and could not draw 120 of the 135 characters the
  // converter produces, so notation reached the page as hollow boxes.
  mathInline: { italics: true },
} as const;
