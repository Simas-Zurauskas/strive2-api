/**
 * Phase 2 — mermaid source to a self-contained, PDF-embeddable SVG.
 *
 * `beautiful-mermaid` emits an SVG that depends on three things a PDF
 * consumer does not have: CSS custom properties, `color-mix()`, and a
 * `<style>` block that `@import`s Google Fonts. Fed straight to pdfmake it
 * renders as solid black boxes with invisible text. Rasterising it with
 * sharp/librsvg fails identically — the problem is the SVG, not the
 * consumer. So `renderDiagram` flattens it.
 *
 * The trap this file is built around: asserting that `var(` and
 * `color-mix(` are ABSENT proves only that something replaced them. A
 * flattener that resolved every colour to black would pass all four
 * absence checks, and the `<text>` elements would still be there — just
 * invisible. So the palette assertions below pin RESOLVED VALUES, and the
 * degeneracy tests have a negative control so the discriminator cannot be
 * tightened until it starts eating real diagrams.
 */

import { describe, test, expect } from 'vitest';
import { CONTENT_HEIGHT, CONTENT_WIDTH } from './theme';
import { flattenSvg, renderDiagram } from './mermaid';
import {
  DEGENERATE_EMPTY_BODY,
  DEGENERATE_MALFORMED,
  DEGENERATE_PROSE,
  MINIMAL_VALID_FLOWCHART,
  PROD_FLOWCHARTS,
  PROD_FLOWCHART_LR_SUBGRAPH,
  PROD_FLOWCHART_TD,
  PROD_SEQUENCE,
  SYNTHETIC_CLASS_DIAGRAM,
  SYNTHETIC_ER_DIAGRAM,
  SYNTHETIC_STATE_DIAGRAM,
} from './__fixtures__/diagrams';

const ok = async (source: string) => {
  const r = await renderDiagram({ source });
  if (!r.ok) throw new Error(`expected ok, got reason=${r.reason}`);
  return r;
};

describe('production diagrams render', () => {
  test.each(PROD_FLOWCHARTS.map((s, i) => [i, s] as const))(
    'production flowchart %i',
    async (_i, source) => {
      const r = await ok(source);
      expect(r.svg).toContain('<text');
    },
  );

  test('production sequenceDiagram', async () => {
    const r = await ok(PROD_SEQUENCE);
    expect(r.svg).toContain('<text');
  });

  test.each([
    ['classDiagram', SYNTHETIC_CLASS_DIAGRAM],
    ['stateDiagram-v2', SYNTHETIC_STATE_DIAGRAM],
    ['erDiagram', SYNTHETIC_ER_DIAGRAM],
  ])('%s — permitted by the generator, unused in production', async (_name, source) => {
    const r = await ok(source);
    expect(r.svg).toContain('<text');
  });
});

describe('the SVG is self-contained', () => {
  // Four separate assertions rather than one combined regex, so a failure
  // names which construct survived.
  test.each(['var(', 'color-mix(', '@import', '<style>'])(
    'no %s survives flattening, in any production diagram',
    async (needle) => {
      for (const source of [...PROD_FLOWCHARTS, PROD_SEQUENCE]) {
        const r = await ok(source);
        expect(r.svg, `"${needle}" survived in: ${source.slice(0, 40)}…`).not.toContain(needle);
      }
    },
  );

  test('no DEREFERENCEABLE url remains — only the xmlns identifiers', async () => {
    const r = await ok(PROD_FLOWCHART_TD);
    // `xmlns` / `xmlns:xlink` are namespace NAMES. They look like URLs and
    // are never fetched, so a blanket /https?:\/\// ban would fail on a
    // correct SVG. Ban the forms that actually cause a fetch instead...
    expect(r.svg).not.toMatch(/@import/);
    expect(r.svg).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(r.svg).not.toMatch(/(?:href|src|xlink:href)\s*=\s*["']https?:/i);
    // ...and then pin that EVERY http occurrence left is an XML namespace
    // name, so a new fetchable URL cannot slip in unnoticed. Asserted as a
    // subset, not an exact set: which namespaces the renderer declares
    // varies with the diagram (xlink only appears when it emits <use>).
    const NAMESPACES = ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink'];
    const urls = [...new Set(r.svg.match(/https?:\/\/[^"'\s)]+/g) ?? [])];
    expect(urls.length).toBeGreaterThan(0); // guards the regex itself
    expect(urls.filter((u) => !NAMESPACES.includes(u))).toEqual([]);
  });
});

describe('colours resolve to the Strive palette, not to black', () => {
  // THE point of this block. The absence assertions above are all satisfied
  // by a flattener that resolves everything to #000000 — which is exactly
  // the bug that was hit in practice. These pin the actual values.
  test.each([
    ['accent (arrowheads)', '#2c5545'],
    ['surface (node fill)', '#ffffff'],
    ['foreground (label text)', '#0f172a'],
    ['border (node stroke)', '#dfd9d3'],
  ])('%s resolves to %s', async (_name, hex) => {
    const r = await ok(PROD_FLOWCHART_TD);
    expect(r.svg.toLowerCase()).toContain(hex);
  });

  test('no fill or stroke collapsed to black', async () => {
    const r = await ok(PROD_FLOWCHART_TD);
    expect(r.svg).not.toMatch(/(fill|stroke)="#000000"/i);
  });

  // The four assertions above only cover colours we HAND the renderer, and
  // those resolve through the first branch of `var(--x, color-mix(…))` —
  // so they never exercise the blend. These two do: neither value is in
  // the palette, both are computed by `colorMix`, and both shift if the
  // blend is wrong. Inverting the operands turns #eeeeed into #1b2234.
  test('a colour-mix-derived value is computed correctly (no subgraph)', async () => {
    const r = await ok(PROD_FLOWCHART_TD);
    expect(r.svg.toLowerCase()).toContain('#dedede');
  });

  test('a colour-mix-derived value is computed correctly (subgraph header)', async () => {
    // --_group-hdr = color-mix(in srgb, var(--fg) 5%, var(--bg))
    //              = 5% of #0f172a + 95% of #faf9f7 = #eeeeed
    const r = await ok(PROD_FLOWCHART_LR_SUBGRAPH);
    expect(r.svg.toLowerCase()).toContain('#eeeeed');
  });
});

describe('label text is never treated as a CSS expression', () => {
  // The flattener once scanned the WHOLE svg for `var(`, so any label
  // containing that substring was eaten. `covar(` is ordinary notation in
  // the statistics domain the generator targets, and it rendered as
  // `conone`. An unbalanced paren was worse: the scan ran to end-of-file
  // and replaced the rest of the document — closing </svg> included.
  const drawn = (svg: string) =>
    [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
      .filter(Boolean);

  test('a label containing "covar(" survives intact', async () => {
    const r = await ok('flowchart TD\n  A["Compute covar(X, Y)"] --> B["Standardise"]');
    expect(drawn(r.svg)).toContain('Compute covar(X, Y)');
  });

  test('a label containing a literal css var() survives intact', async () => {
    const r = await ok('flowchart TD\n  A["Theme token: var(--brand)"] --> B["Apply"]');
    expect(drawn(r.svg)).toContain('Theme token: var(--brand)');
  });

  test('an unbalanced paren in a label cannot truncate the document', async () => {
    const r = await ok('flowchart TD\n  A["Start"] --> B["Middle"]\n  B --> C["Read var( from file"]');
    expect(r.svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(drawn(r.svg)).toHaveLength(3); // no node dropped
  });

  test('paint attributes are still resolved — the fix did not disable flattening', async () => {
    const r = await ok('flowchart TD\n  A["Compute covar(X, Y)"] --> B["Standardise"]');
    // NB: a blanket `not.toContain('var(')` is wrong here — the label
    // legitimately contains `covar(`. What must be free of `var()` is the
    // paint attributes, which is exactly the scope of the fix.
    const paints = [...r.svg.matchAll(/\s(?:fill|stroke|style)="([^"]*)"/g)].map((m) => m[1]);
    expect(paints.length).toBeGreaterThan(0);
    expect(paints.filter((v) => /(?:var|color-mix)\(/.test(v))).toEqual([]);
    expect(r.svg.toLowerCase()).toContain('#ffffff');
  });
});

describe('an unresolvable palette is refused, not shipped invisible', () => {
  test('flattenSvg reports unresolved for an unknown variable', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
      + '<rect fill="var(--not-a-real-token)" /><text>x</text></svg>';
    expect(flattenSvg(svg).unresolved).toBeGreaterThan(0);
  });

  test('an unresolved paint value never reaches a document', () => {
    // `none` is a legal SVG paint, so an all-unresolved diagram would lay
    // out fine, keep its <text>, pass the degeneracy check, and print as
    // empty boxes. Refusing is the honest outcome.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
      + '<rect fill="var(--gone)" stroke="var(--gone)" /><text>x</text></svg>';
    const flat = flattenSvg(svg);
    expect(flat.unresolved).toBe(2);
    expect(flat.svg).toContain('none');
  });
});

describe('degenerate sources are refused — with a negative control', () => {
  test.each([
    ['malformed', DEGENERATE_MALFORMED],
    ['empty body', DEGENERATE_EMPTY_BODY],
    ['prose mistaken for a diagram', DEGENERATE_PROSE],
  ])('%s is reported ok:false', async (_name, source) => {
    const r = await renderDiagram({ source });
    expect(r.ok).toBe(false);
  });

  test('NEGATIVE CONTROL — a minimal two-node flowchart is still accepted', async () => {
    // Without this, the degeneracy discriminator could be tightened until
    // it swallowed real diagrams and every other test here would stay green.
    const r = await ok(MINIMAL_VALID_FLOWCHART);
    expect(r.svg).toContain('<text');
  });

  test('a degenerate source never throws', async () => {
    await expect(renderDiagram({ source: DEGENERATE_MALFORMED })).resolves.toBeDefined();
  });
});

describe('sizing', () => {
  test('width and height come from the SVG, not from a constant', async () => {
    const wide = await ok(PROD_FLOWCHART_LR());
    const narrow = await ok(MINIMAL_VALID_FLOWCHART);
    expect(wide.width).not.toBeCloseTo(narrow.width, 5);
    expect(wide.width).toBeGreaterThan(0);
    expect(wide.height).toBeGreaterThan(0);
  });

  test('every production diagram fits the content box on BOTH axes', async () => {
    // A width-only rule passes a diagram that is 191pt taller than the page.
    for (const source of [...PROD_FLOWCHARTS, PROD_SEQUENCE]) {
      const r = await ok(source);
      expect(r.width).toBeLessThanOrEqual(CONTENT_WIDTH + 0.01);
      expect(r.height).toBeLessThanOrEqual(CONTENT_HEIGHT + 0.01);
    }
  });

  test('a small diagram is never scaled UP to fill the column', async () => {
    const r = await ok(MINIMAL_VALID_FLOWCHART);
    expect(r.width).toBeLessThan(CONTENT_WIDTH);
  });
});

function PROD_FLOWCHART_LR(): string {
  return PROD_FLOWCHARTS[1];
}
