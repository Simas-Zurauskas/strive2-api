/**
 * Lesson blocks → pdfmake content. This is where the "what goes in a PDF"
 * policy lives.
 *
 * IN:  intro, section, callout, code, mermaid, summary, links, image, and
 *      an exercise's PROSE.
 * OUT: quiz entirely, and an exercise's `starterCode` / `expectedOutput`.
 *
 * The exercise split is not a guess. Only 4 of 115 production exercise
 * blocks carry starter code; the other 111 are prose-only conceptual
 * practice, and dropping them all to exclude 4 would delete real study
 * material. `lib/narration/blocksToScript.ts:106-127` already draws exactly
 * this line for narration — prose narrated, runnable code replaced by a cue.
 *
 * Exclusion is a runtime SET consulted before the render switch, not a
 * `case` arm. That is deliberate: with a `case` the switch's `never`
 * default makes removing a type a COMPILE error, which means the exclusion
 * can never be shown to fail at runtime — and a check that cannot go red
 * is not a check.
 */

import type { Content } from 'pdfmake/interfaces';
import type { BlockType, ILessonBlock } from '@models/LessonContentModel';
import { COLORS, FONT_SIZE, LINE_HEIGHT } from './theme';
import { codeBlockContent, isSafeLinkHref, markdownToContent } from './markdown';
import { renderDiagram } from './mermaid';
import { pdfLog } from '@lib/loggers';

/** Blocks that never appear in an export. See the header note. */
export const EXCLUDED_BLOCK_TYPES: ReadonlySet<BlockType> = new Set<BlockType>(['quiz']);

const CALLOUT_LABELS: Record<string, { label: string; color: string }> = {
  info: { label: 'Note', color: COLORS.muted },
  tip: { label: 'Tip', color: COLORS.goldText },
  warning: { label: 'Warning', color: COLORS.warning },
  important: { label: 'Important', color: COLORS.error },
  key_concept: { label: 'Key Concept', color: COLORS.accent },
};

const meta = (block: ILessonBlock): Record<string, unknown> =>
  (block.metadata ?? {}) as Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const calloutContent = (block: ILessonBlock): Content => {
  const variant = str(meta(block).variant) || 'info';
  const { label, color } = CALLOUT_LABELS[variant] ?? CALLOUT_LABELS.info;
  return {
    table: {
      widths: ['*'],
      body: [
        [
          {
            stack: [
              { text: label.toUpperCase(), style: 'calloutLabel', color },
              ...markdownToContent(block.content),
            ],
            fillColor: COLORS.surface,
            margin: [10, 8, 10, 2],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: (i: number) => (i === 0 ? 2 : 0),
      vLineColor: () => color,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 7, 0, 9],
  } as Content;
};

const linksContent = (block: ILessonBlock): Content[] => {
  const raw = meta(block).links;
  const links = Array.isArray(raw)
    ? (raw as { title?: string; url?: string; description?: string }[])
    : [];
  if (links.length === 0) return [];
  return [
    { text: 'Further reading', style: 'h2' } as Content,
    ...links.flatMap((l) => {
      const title = str(l.title) || str(l.url);
      if (!title) return [];
      const url = str(l.url);
      const out: Content[] = [
        {
          text: title,
          // Curated links are LLM-selected, so the scheme is not trusted.
          link: url && isSafeLinkHref(url) ? url : undefined,
          style: 'linkTitle',
        } as Content,
      ];
      if (str(l.description)) out.push({ text: str(l.description), style: 'linkDesc' } as Content);
      return out;
    }),
  ];
};

/**
 * Exercise: prose only. `starterCode` and `expectedOutput` are never
 * emitted — an editor is not a page, and the requirement excludes coding
 * challenges. The prose is kept because it is the teaching content.
 */
const exerciseContent = (block: ILessonBlock): Content[] => {
  const body = markdownToContent(block.content);
  if (body.length === 0) return [];
  return [{ text: 'Practice', style: 'h2' } as Content, ...body];
};

/**
 * `image` blocks: the type exists in `BLOCK_TYPES` but **no generator writes
 * one** — zero across all 112 production lessons — and the client has no
 * renderer for them either. So there is no established metadata shape to
 * read, and inventing one here would be a branch that silently renders
 * nothing whatever a future producer actually chose.
 *
 * Instead: accept a `data:` URI if one is ever present, and otherwise leave
 * a visible placeholder rather than a hole, so the first real image block
 * announces itself instead of vanishing.
 */
const imageContent = (block: ILessonBlock): Content[] => {
  const src = str(meta(block).dataUri) || str(meta(block).url);
  if (src.startsWith('data:')) {
    return [{ image: src, width: 320, alignment: 'center', margin: [0, 7, 0, 9] } as Content];
  }
  return [{ text: 'Image — view this lesson in Strive', style: 'diagramFallback' } as Content];
};

const diagramFallback = (block: ILessonBlock): Content => ({
  text: `Diagram — ${str(meta(block).diagramType) || 'diagram'} — view this lesson in Strive`,
  style: 'diagramFallback',
});

export interface BlocksToContentResult {
  content: Content[];
  diagrams: number;
  diagramFallbacks: number;
}

/**
 * Async because diagram rendering reaches an ESM-only renderer through
 * `await import`. It is in-process CPU work — no Mongo, no S3, no HTTP — so
 * the document builders above it stay free of I/O.
 */
export const blocksToContent = async (blocks: ILessonBlock[]): Promise<BlocksToContentResult> => {
  // Defensive numeric sort: real `order` values are fractional (7.5, 11.5)
  // because quizzes are interleaved after the prose is generated.
  const sorted = [...blocks].sort((a, b) => a.order - b.order);

  const content: Content[] = [];
  let diagrams = 0;
  let diagramFallbacks = 0;

  for (const block of sorted) {
    if (EXCLUDED_BLOCK_TYPES.has(block.type)) continue;

    switch (block.type) {
      case 'intro':
        // Markdown, like every other prose block. The generator is told to
        // "use markdown formatting within text blocks"
        // (`lib/ai/agents/lessonGeneration/prompts.ts:205`) and the app
        // renders intros through `LessonMarkdown`, so emitting the raw
        // string here printed `**bold**` and `$k=5$` as literal source.
        // `lead` styling is applied by wrapping, since markdownToContent
        // sets its own `body` style per node.
        content.push({
          stack: markdownToContent(block.content),
          style: 'lead',
        } as Content);
        break;
      case 'section':
      case 'summary':
        if (block.type === 'summary') content.push({ text: 'Summary', style: 'h2' } as Content);
        content.push(...markdownToContent(block.content));
        break;
      case 'callout':
        content.push(calloutContent(block));
        break;
      case 'code':
        content.push(codeBlockContent(block.content, str(meta(block).language)));
        break;
      case 'mermaid': {
        const r = await renderDiagram({ source: block.content });
        if (r.ok) {
          diagrams++;
          content.push({
            svg: r.svg,
            width: r.width,
            height: r.height,
            alignment: 'center',
            margin: [0, 8, 0, 10],
          } as Content);
        } else {
          diagramFallbacks++;
          pdfLog.info(`diagram:fallback type=${str(meta(block).diagramType) || '?'} reason=${r.reason}`);
          content.push(diagramFallback(block));
        }
        break;
      }
      case 'exercise':
        content.push(...exerciseContent(block));
        break;
      case 'links':
        content.push(...linksContent(block));
        break;
      case 'image':
        content.push(...imageContent(block));
        break;
      case 'quiz':
        // Not dead code by accident. `EXCLUDED_BLOCK_TYPES` is the SINGLE
        // point of policy, so this arm renders a quiz the way any other
        // prose block would render. Two consequences, both wanted:
        //   - the exclusion is falsifiable — remove `quiz` from the set and
        //     a quiz's content reaches the page, which a test can catch. A
        //     second guard here would make the set unremovable-in-effect
        //     and the check impossible to turn red.
        //   - if the policy ever changes, this is already the honest render.
        content.push(...markdownToContent(block.content));
        break;
      default: {
        const exhaustive: never = block.type;
        void exhaustive;
        break;
      }
    }
  }

  return { content, diagrams, diagramFallbacks };
};

/** Styles the block renderer depends on, merged into the document. */
export const BLOCK_STYLES = {
  lead: {
    fontSize: FONT_SIZE.body + 0.3,
    italics: true,
    color: COLORS.muted,
    lineHeight: 1.5,
    margin: [0, 4, 0, 8],
  },
  calloutLabel: { fontSize: FONT_SIZE.tiny - 0.5, bold: true, characterSpacing: 1.2, margin: [0, 0, 0, 3] },
  linkTitle: { fontSize: FONT_SIZE.body, color: COLORS.accent, decoration: 'underline' as const },
  linkDesc: { fontSize: FONT_SIZE.small, color: COLORS.muted, margin: [0, 2, 0, 7], lineHeight: LINE_HEIGHT },
  diagramFallback: {
    fontSize: FONT_SIZE.small,
    italics: true,
    color: COLORS.muted,
    alignment: 'center' as const,
    margin: [0, 7, 0, 9],
  },
} as const;
