/**
 * LaTeX → SVG, for embedding maths in a PDF.
 *
 * Why MathJax and not the KaTeX already in this repo: KaTeX renders to
 * HTML/MathML, and pdfmake draws neither. MathJax's SVG output is
 * path-based — no font embedding, no network reference — which is exactly
 * what `pdfmake`'s `{ svg }` node wants.
 *
 * What counts AS maths is not decided here. `lib/latexSanitizer` owns the
 * delimiter rules the app already uses (its inline rule deliberately
 * refuses `$5` in prose), and the markdown converter imports them from
 * there so the PDF and the screen never disagree.
 *
 * MathJax sizes its output in `ex` units relative to the surrounding text.
 * pdfmake's `fit: [w, h]` scales an SVG UP to fill the box, which turns a
 * short inline expression into a full-width banner, so the point size is
 * derived from those `ex` values instead and passed as explicit
 * width/height.
 */

import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { CONTENT_HEIGHT, CONTENT_WIDTH, FONT_SIZE } from './theme';

export interface RenderedMath {
  svg: string;
  /** points */
  width: number;
  /** points */
  height: number;
}

/**
 * Building the MathJax document is the expensive part (~100 ms); rendering
 * an expression against it is ~14 ms. Built once, lazily, so importing this
 * module stays cheap for the many code paths that never render maths.
 */
let doc: ReturnType<typeof mathjax.document> | null = null;
let adaptor: ReturnType<typeof liteAdaptor> | null = null;

const getDoc = () => {
  if (!doc || !adaptor) {
    adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    doc = mathjax.document('', {
      InputJax: new TeX({ packages: AllPackages }),
      // `fontCache: 'none'` inlines each glyph path instead of emitting
      // <use> references into a shared <defs>. Larger output, but every
      // SVG is then independent — which matters because each one is
      // embedded into the PDF as a separate object.
      OutputJax: new SVG({ fontCache: 'none' }),
    });
  }
  return { doc, adaptor };
};

/**
 * 1ex ≈ half the font size for the fonts in use. Good enough: the value
 * only sets the on-page scale of the expression relative to body text, and
 * being a point or two out is invisible.
 */
const EX_IN_POINTS = FONT_SIZE.body * 0.5;

const dimension = (svg: string, name: 'width' | 'height'): number => {
  const ex = parseFloat(new RegExp(`${name}="([\\d.]+)ex"`).exec(svg)?.[1] ?? '');
  return Number.isFinite(ex) ? ex * EX_IN_POINTS : 0;
};

/**
 * Render one LaTeX expression. Returns `null` when the TeX does not parse —
 * the caller falls back to showing the source, which is honest and never
 * fails an export.
 */
export const renderMath = ({ tex, display }: { tex: string; display: boolean }): RenderedMath | null => {
  if (!tex.trim()) return null;
  try {
    const { doc: d, adaptor: a } = getDoc();
    const node = d.convert(tex, { display });
    // `innerHTML` of the mjx-container strips the wrapper and leaves <svg>.
    let svg = a.innerHTML(node);
    if (!svg.startsWith('<svg')) return null;

    // Strip anchors. `AllPackages` includes MathJax's `html` package, so
    // `$$\href{javascript:alert(1)}{x}$$` in LLM-written lesson text
    // reaches the SVG as `<a href="javascript:…">` — and pdfmake's bundled
    // svg-to-pdfkit turns any `<a href>` into a PDF /URI annotation with a
    // scheme regex that matches everything. Verified end to end: the
    // rendered PDF carried `/URI (javascript:alert\(1\))` while
    // `setUrlAccessPolicy(() => false)` was still in force, because that
    // policy governs resource FETCHES, not link annotations.
    //
    // The tags are unwrapped rather than deleted so the maths inside an
    // anchor still renders; only the link is withheld.
    svg = svg.replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '');
    svg = svg.replace(/\s(?:xlink:href|href)\s*=\s*"[^"]*"/gi, '');
    // MathJax renders a parse error as a red `merror` element rather than
    // throwing. That is useful on screen and wrong in a printed document.
    if (svg.includes('data-mjx-error') || svg.includes('merror')) return null;

    const width = dimension(svg, 'width');
    const height = dimension(svg, 'height');
    if (!(width > 0) || !(height > 0)) return null;

    // Clamp to the page on both axes, exactly as `renderDiagram` does. A
    // wide display expression — a long matrix, a many-term alignment — can
    // measure past 700 pt against a 467 pt column, and pdfmake does not
    // clip: it draws past the margin. Never scaled UP.
    const scale = Math.min(CONTENT_WIDTH / width, CONTENT_HEIGHT / height, 1);
    return { svg, width: width * scale, height: height * scale };
  } catch {
    return null;
  }
};
