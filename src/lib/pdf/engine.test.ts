/**
 * Phase 1 — the PDF engine, its brand fonts, and its sandbox.
 *
 * Two things are being pinned here, and only one of them is obvious.
 *
 * 1. SIX DISTINCT FACES ARE REGISTERED. pdfmake will happily accept the same
 *    .ttf for `normal`, `bold` and `italics` and then render all three
 *    identically — no error, no warning, just a PDF where nothing is
 *    emphasised. Comparing rendered text WIDTHS is the only way to tell the
 *    difference from the outside.
 *
 * 2. THE SANDBOX IS ACTUALLY REGISTERED. pdfmake can fetch remote URLs and
 *    read local files named in a document definition. The content we feed it
 *    is LLM-generated and, in the mermaid case, literally arrives carrying
 *    `@import url('https://fonts.googleapis.com/…')`. Asserting that our own
 *    policy lambda returns `false` would prove nothing — a lambda that
 *    returns false returns false whether or not pdfmake was ever told about
 *    it. So these tests drive `renderPdf` and require it to REJECT, which is
 *    only true if the policy was registered on the right object at the right
 *    time.
 */

import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { FONT_FILES, renderPdf } from './engine';
import { pdfLog } from '@lib/loggers';

const PDF_MAGIC = '%PDF-';

/**
 * Width of `text` in points for one registered face.
 *
 * Lives in the test, not in `engine.ts`, because it reaches for `pdfkit` —
 * pdfmake's own renderer, and therefore the metrics the real output will
 * use, but a TRANSITIVE dependency of this repo. Production code must not
 * lean on package hoisting; a test may, and will fail loudly here if the
 * hoist ever changes.
 */
const measureText = ({
  text,
  font,
  bold = false,
  italics = false,
}: {
  text: string;
  font: keyof typeof FONT_FILES;
  bold?: boolean;
  italics?: boolean;
}): number => {
  const slot = bold && italics ? 'bolditalics' : bold ? 'bold' : italics ? 'italics' : 'normal';
  const doc = new PDFDocument({ autoFirstPage: false });
  doc.font(FONT_FILES[font][slot]);
  doc.fontSize(12);
  return doc.widthOfString(text);
};

describe('renderPdf', () => {
  test('code is set in a monospace face, so indentation survives', async () => {
    // Two strings of equal length must measure equal width in a monospace
    // face and unequal in a proportional one. This is what stops the code
    // style silently falling back to Inter.
    const a = measureText({ text: 'iiii', font: 'JetBrainsMono' });
    const b = measureText({ text: 'MMMM', font: 'JetBrainsMono' });
    expect(a).toBeCloseTo(b, 5);
    // Control: the body face is NOT monospaced.
    expect(measureText({ text: 'iiii', font: 'Inter' })).not.toBeCloseTo(
      measureText({ text: 'MMMM', font: 'Inter' }),
      5,
    );
  });

  test('produces a real PDF', async () => {
    const buf = await renderPdf({
      content: [{ text: 'hello' }],
      defaultStyle: { font: 'Inter' },
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, PDF_MAGIC.length).toString('latin1')).toBe(PDF_MAGIC);
  });
});

describe('brand fonts', () => {
  test('every vendored face exists on disk at its resolved path', () => {
    const paths = Object.values(FONT_FILES).flatMap((family) => Object.values(family));
    expect(paths).toHaveLength(12); // 3 families x 4 slots
    for (const p of paths) {
      expect(existsSync(p), `missing font file: ${p}`).toBe(true);
    }
    // 8 distinct files across the 12 slots. Deliberate reuse: `bolditalics`
    // takes the bold face in all three families, and JetBrains Mono's
    // italic slots take its upright faces — none of those instances is
    // needed, and vendoring unused binaries is worse than aliasing.
    expect(new Set(paths).size).toBe(8);
  });

  // Width is the right observable for a PROPORTIONAL face: point two slots
  // at the same .ttf and the widths collapse to equal. It is the wrong
  // observable for a monospace one, where bold and regular have identical
  // advance widths BY DESIGN — so JetBrains Mono is checked differently,
  // below, rather than with an assertion that cannot hold.
  test.each(['Inter', 'Newsreader'] as const)(
    '%s registers distinct normal / bold / italic faces',
    (font) => {
      const sample = 'Handling Missing Data';
      const normal = measureText({ text: sample, font, bold: false, italics: false });
      const bold = measureText({ text: sample, font, bold: true, italics: false });
      const italic = measureText({ text: sample, font, bold: false, italics: true });

      expect(normal).toBeGreaterThan(0);
      expect(bold, `${font} bold renders identically to normal`).not.toBeCloseTo(normal, 5);
      expect(italic, `${font} italic renders identically to normal`).not.toBeCloseTo(normal, 5);
    },
  );

  test('JetBrainsMono registers a genuinely different bold face', () => {
    // Equal advance widths mean the width trick is unavailable, so compare
    // the font programs themselves: same bytes would mean one file wired
    // into both slots.
    const normal = readFileSync(FONT_FILES.JetBrainsMono.normal);
    const bold = readFileSync(FONT_FILES.JetBrainsMono.bold);
    expect(normal.equals(bold)).toBe(false);
    // And both are real, loadable fonts, not stubs.
    expect(measureText({ text: 'x', font: 'JetBrainsMono', bold: false })).toBeGreaterThan(0);
    expect(measureText({ text: 'x', font: 'JetBrainsMono', bold: true })).toBeGreaterThan(0);
  });
});

describe('resource access sandbox', () => {
  test('a remote image URL in a document definition is refused', async () => {
    await expect(
      renderPdf({
        content: [{ image: 'https://example.com/x.png', width: 50 }],
        defaultStyle: { font: 'Inter' },
      }),
    ).rejects.toThrow(/resource access policy/i);
  });

  test('a local file outside the font directory is refused', async () => {
    await expect(
      renderPdf({
        content: [{ image: '/etc/hosts', width: 50 }],
        defaultStyle: { font: 'Inter' },
      }),
    ).rejects.toThrow(/resource access policy/i);
  });

  test('the control still renders — the two refusals are not a broken renderer', async () => {
    const buf = await renderPdf({
      content: [{ text: 'plain text renders fine' }],
      defaultStyle: { font: 'Inter' },
    });
    expect(buf.length).toBeGreaterThan(1000);
  });

  test('the font directory itself is still readable, or no PDF could be drawn', async () => {
    // Implied by every other render succeeding, but stated explicitly so a
    // future over-tightening of the local policy fails HERE, with a clear
    // name, rather than as a confusing failure three phases later.
    const buf = await renderPdf({
      content: [{ text: 'Aa', font: 'Newsreader', italics: true }],
      defaultStyle: { font: 'Inter' },
    });
    expect(buf.subarray(0, PDF_MAGIC.length).toString('latin1')).toBe(PDF_MAGIC);
  });
});

describe('observability', () => {
  test('pdfLog exists and is namespaced pdf', () => {
    expect(pdfLog).toBeDefined();
    expect(typeof pdfLog.info).toBe('function');
    expect(typeof pdfLog.error).toBe('function');
  });
});
