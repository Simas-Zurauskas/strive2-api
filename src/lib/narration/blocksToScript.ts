import { ILessonBlock } from '@models/LessonContentModel';

/**
 * Convert a lesson's structured blocks into a single plain-text narration
 * script ready to send to a TTS engine.
 *
 * Pure function — no I/O, no time-dependent values. Critical because the
 * script's hash determines the S3 cache key (and therefore whether we hit
 * the vendor or reuse a previous synthesis). Any non-determinism here would
 * silently inflate vendor cost by missing cache hits.
 *
 * Block-by-block treatment (see plan doc and `BLOCK_TYPES`):
 *   intro, section, summary  → narrate (markdown stripped to plain prose)
 *   callout                  → narrate, prefix by variant ("Note:", "Warning:", "Tip:")
 *   exercise                 → narrate prose only; if `metadata.starterCode`
 *                              is present we replace the runnable code with
 *                              a short audio cue
 *   code                     → replaced by a one-line audio cue
 *   mermaid                  → replaced by a one-line audio cue
 *   image                    → skipped silently (read alt text if present)
 *   links                    → skipped (link lists are visual)
 *   quiz                     → skipped entirely
 *
 * Math handling: $...$ and $$...$$ blocks become "[math expression]" so the
 * TTS engine doesn't read raw LaTeX aloud. Documented v1 limitation.
 */

const NARRATABLE_TYPES = new Set(['intro', 'section', 'summary', 'callout', 'exercise']);

const stripMarkdown = (markdown: string): string => {
  let text = markdown;

  // Math first — strip before list/heading rules touch the dollar signs.
  // $$...$$ display math (multiline-tolerant) → placeholder.
  text = text.replace(/\$\$[\s\S]+?\$\$/g, ' [math expression] ');
  // $...$ inline math. Negative lookbehind to avoid eating "$5" prices and
  // similar (rare in lessons but worth defending against). Single-line so
  // we don't accidentally span paragraphs.
  text = text.replace(/(?<!\\)\$([^$\n]+?)\$/g, ' [math expression] ');

  // Fenced code blocks — content already lives in `code` blocks, but inline
  // markdown can still embed them; replace with audio cue.
  text = text.replace(/```[\s\S]*?```/g, ' (code example) ');

  // Inline code — strip backticks but keep the contents (it's usually a
  // short identifier or keyword that reads fine).
  text = text.replace(/`([^`]+)`/g, '$1');

  // Headings → plain text (drop the leading hashes; trailing newline kept).
  text = text.replace(/^#{1,6}\s+/gm, '');

  // Bold / italic / strikethrough — keep contents, drop markers.
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');

  // Markdown links: [label](url) → label. URLs spoken aloud are useless.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

  // Images: ![alt](url) → alt (or skip silently if no alt).
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1');

  // List markers (-, *, +, 1.) at line starts — drop the marker, keep the
  // text; TTS reads list items as separate sentences naturally.
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');

  // Blockquote markers.
  text = text.replace(/^\s*>\s?/gm, '');

  // Horizontal rules.
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // Collapse runs of whitespace but preserve paragraph breaks (double
  // newlines). Paragraph breaks become natural sentence pauses for TTS.
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]*\n[ \t]*/g, '\n');

  return text.trim();
};

const normaliseSentenceTerminator = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  // TTS prosody benefits from explicit terminators between blocks. Add a
  // period if the trailing char isn't already a sentence-ending punctuation.
  return /[.!?;:…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const renderCalloutBlock = (block: ILessonBlock): string => {
  const meta = (block.metadata ?? {}) as { variant?: string };
  const variant = (meta.variant ?? '').toLowerCase();
  const prefix =
    variant === 'warning' ? 'Warning: '
      : variant === 'success' ? 'Tip: '
        : variant === 'info' ? 'Note: '
          : '';
  const body = stripMarkdown(block.content);
  if (!body) return '';
  return normaliseSentenceTerminator(`${prefix}${body}`);
};

const renderExerciseBlock = (block: ILessonBlock): string => {
  const meta = (block.metadata ?? {}) as {
    language?: string;
    starterCode?: string;
  };
  const isCodingExercise = !!(meta.language && meta.starterCode);
  const prose = stripMarkdown(block.content);

  // Coding exercises: keep the prose framing, replace the code with a cue
  // so the listener knows visual content is on screen but doesn't get a
  // full LaTeX/code dump read aloud.
  if (isCodingExercise) {
    if (!prose) return '';
    return normaliseSentenceTerminator(
      `Exercise: ${prose} The rest is a coding exercise in ${meta.language}.`,
    );
  }

  // Conceptual exercise (no starter code) — narrate fully.
  if (!prose) return '';
  return normaliseSentenceTerminator(`Exercise: ${prose}`);
};

const renderImageAltText = (block: ILessonBlock): string => {
  const meta = (block.metadata ?? {}) as { alt?: string };
  const alt = (meta.alt ?? '').trim();
  return alt ? normaliseSentenceTerminator(`Image: ${alt}`) : '';
};

/**
 * Render a single block to a narration string, or empty if it should be
 * skipped. Centralises the per-type policy in one place so the test fixture
 * can target every branch deterministically.
 */
export const renderBlockForNarration = (block: ILessonBlock): string => {
  switch (block.type) {
    case 'intro':
    case 'section':
      return normaliseSentenceTerminator(stripMarkdown(block.content));
    case 'summary':
      return normaliseSentenceTerminator(`In summary, ${stripMarkdown(block.content)}`);
    case 'callout':
      return renderCalloutBlock(block);
    case 'exercise':
      return renderExerciseBlock(block);
    case 'code':
      return 'Code example shown.';
    case 'mermaid':
      return 'Diagram shown.';
    case 'image':
      return renderImageAltText(block);
    case 'links':
    case 'quiz':
      return '';
    default:
      return '';
  }
};

/**
 * Build the final narration script from a sorted block list. Sorts defensively
 * by `order` so a caller-side mistake (passing un-sorted blocks) doesn't
 * scramble the spoken sequence.
 */
export const blocksToNarrationScript = (blocks: ILessonBlock[]): string => {
  const sorted = [...blocks].sort((a, b) => a.order - b.order);
  const parts = sorted.map(renderBlockForNarration).filter((p) => p.length > 0);
  return parts.join('\n\n');
};

/**
 * True when a lesson has any narratable content at all. Used by the
 * controller to reject "narrate this" requests early on lessons that are
 * 100% quizzes / images / code with no text.
 */
export const hasNarratableContent = (blocks: ILessonBlock[]): boolean =>
  blocks.some((b) => NARRATABLE_TYPES.has(b.type) && stripMarkdown(b.content).length > 0);
