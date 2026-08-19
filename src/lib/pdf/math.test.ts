/**
 * Phase 3 — LaTeX to SVG for the PDF.
 *
 * KaTeX already runs in this repo (`lib/latexSanitizer`) but cannot emit
 * SVG, so MathJax does the rendering. What the app and the PDF must agree
 * on is *what counts as maths*, which is why the delimiter regexes are
 * imported from `latexSanitizer` rather than re-derived here — `$5` in
 * prose is not an equation.
 */

import { describe, test, expect } from 'vitest';
import { displayMathRe, inlineMathRe } from '@lib/latexSanitizer';
import { CONTENT_WIDTH } from './theme';
import { renderMath } from './math';

/** Verbatim from production `section` blocks. */
const PROD_EXPRESSIONS = [
  'P(M \\mid X_{obs}, X_{mis}) = P(M)',
  '\\hat{\\sigma}^2_{imp} = \\hat{\\sigma}^2 \\cdot \\frac{n_{obs}}{n_{obs} + n_{mis}}',
  'd_{nan}(x_i, x_l) = \\sqrt{\\frac{n_{features}}{n_{observed}}} \\cdot \\|x_i^{(obs)} - x_l^{(obs)}\\|_2',
  'E[X_j \\mid X_{-j}]',
  'O(n^2 \\cdot p)',
];

describe('rendering', () => {
  test.each(PROD_EXPRESSIONS.map((t, i) => [i, t] as const))(
    'production expression %i renders to path-based SVG',
    (_i, tex) => {
      const r = renderMath({ tex, display: true });
      expect(r).not.toBeNull();
      expect(r!.svg).toContain('<svg');
      // Path glyphs, not font references — nothing to embed, nothing to fetch.
      expect(r!.svg).toContain('<path');
      expect(r!.svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    },
  );

  test('invalid TeX degrades to null rather than throwing', () => {
    expect(renderMath({ tex: '\\frac{', display: false })).toBeNull();
    expect(renderMath({ tex: '\\begin{nope}x\\end{nope}', display: true })).toBeNull();
  });

  test('empty input is null', () => {
    expect(renderMath({ tex: '   ', display: false })).toBeNull();
  });
});

describe('the SVG carries no link annotation', () => {
  // `AllPackages` includes MathJax's `html` package, so LLM lesson text can
  // write `$$\\href{javascript:…}{x}$$`. pdfmake's bundled svg-to-pdfkit
  // turns any `<a href>` into a PDF /URI annotation with a scheme regex
  // that matches everything — and `setUrlAccessPolicy` does not cover it,
  // because that governs resource FETCHES, not annotations.
  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>x</script>',
    'https://example.com/ok',
  ])('\\href{%s} produces no anchor and no href', (url) => {
    const r = renderMath({ tex: `\\href{${url}}{x+1}`, display: true });
    expect(r).not.toBeNull();
    expect(r!.svg).not.toMatch(/<a\b/i);
    expect(r!.svg).not.toMatch(/href\s*=/i);
  });

  test('the maths inside an anchor still renders', () => {
    const r = renderMath({ tex: '\\href{https://example.com}{x+1}', display: true });
    expect(r!.svg).toContain('<path');
  });
});

describe('display mode is actually honoured', () => {
  // Comparing a fraction to `k = 5` would prove only that fractions are
  // taller than one-liners — it passes with `display` hardcoded off. The
  // SAME expression in both modes is the only comparison that isolates it.
  test('the same expression is taller in display mode than inline', () => {
    const tex = '\\frac{a}{b}';
    const inline = renderMath({ tex, display: false })!;
    const block = renderMath({ tex, display: true })!;
    expect(inline).not.toBeNull();
    expect(block).not.toBeNull();
    expect(block.height).toBeGreaterThan(inline.height);
  });
});

describe('sizing comes from the SVG, not a constant', () => {
  test('a wide expression is wider than a narrow one', () => {
    const wide = renderMath({ tex: PROD_EXPRESSIONS[2], display: true })!;
    const narrow = renderMath({ tex: 'k = 5', display: false })!;
    expect(wide.width).toBeGreaterThan(narrow.width * 2);
  });

  test('a very wide expression is clamped to the page, not drawn past the margin', () => {
    const wide = renderMath({
      tex: '\\begin{matrix}' + Array.from({ length: 40 }, (_, i) => `a_{${i}}`).join(' & ') + '\\end{matrix}',
      display: true,
    });
    expect(wide).not.toBeNull();
    expect(wide!.width).toBeLessThanOrEqual(CONTENT_WIDTH + 0.01);
  });

  test('dimensions are positive and finite', () => {
    const r = renderMath({ tex: 'x^2', display: false })!;
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(Number.isFinite(r.width)).toBe(true);
  });
});

describe('the delimiter rules are the app’s, not re-derived', () => {
  test('a price is not maths, but an equation is', () => {
    expect(inlineMathRe().test('costs $5 today')).toBe(false);
    expect(inlineMathRe().test('let $k = 5$ here')).toBe(true);
  });

  test('display delimiters match $$…$$', () => {
    expect(displayMathRe().test('before $$x^2$$ after')).toBe(true);
  });

  // The `g` flag makes `lastIndex` per-object state. If these were exported
  // constants rather than factories, a `.test()` in one module would make
  // the next module's `.exec()` loop skip its first match.
  test('each call returns a FRESH regex with lastIndex 0', () => {
    const a = inlineMathRe();
    a.test('let $k = 5$ here');
    expect(a.lastIndex).toBeGreaterThan(0);
    expect(inlineMathRe().lastIndex).toBe(0);
  });
});
