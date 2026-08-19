/**
 * Inline maths → text.
 *
 * The assertion that matters most is the coverage one: this module can only
 * emit a character the embedded face can DRAW. A missing glyph is not a
 * blank in these fonts — it is `.notdef`, a hollow box — so an unchecked
 * substitution turns notation into `□`. An earlier version styled inline
 * maths in Newsreader, which cannot draw 120 of the 135 characters here,
 * and shipped `E[X_j \mid X_{-j}]` to the page as `E[X□ □ X□□]`.
 */

import { describe, test, expect } from 'vitest';
import { FONT_FILES } from './engine';
import { COMMANDS_FOR_TESTS, SCRIPTS_FOR_TESTS, inlineMathToText } from './inlineMath';

describe('every character this module can emit is drawable', () => {
  // `fontkit` ships no types and is a transitive dep (via pdfkit/pdfmake),
  // so it is reached the same way the engine test reaches pdfkit: from the
  // test, never from production code.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fontkit = require('fontkit') as {
    openSync(p: string): { hasGlyphForCodePoint(cp: number): boolean };
  };
  const font = fontkit.openSync(FONT_FILES.Inter.normal);
  const drawable = (ch: string) => ch.codePointAt(0)! < 128 || font.hasGlyphForCodePoint(ch.codePointAt(0)!);

  test('super/subscript substitutions are all in the inline-maths face', () => {
    const missing = SCRIPTS_FOR_TESTS.filter((ch) => !drawable(ch));
    expect(missing, `not drawable: ${missing.join('')}`).toEqual([]);
  });

  test('every command symbol is either drawable or has a drawable ASCII spelling', () => {
    // A symbol with neither makes the whole expression `faithful: false`,
    // so it never reaches the page — asserted by the conversions below.
    for (const symbol of COMMANDS_FOR_TESTS) {
      const rendered = inlineMathToText(`a \\${symbol.name} b`);
      if (!rendered.faithful) continue;
      const bad = [...rendered.text].filter((ch) => !drawable(ch));
      expect(bad, `\\${symbol.name} emitted undrawable: ${bad.join('')}`).toEqual([]);
    }
  });
});

describe('conversions', () => {
  test.each([
    ['\\sigma^2', 'σ²'],
    ['\\alpha \\le \\beta', 'α ≤ β'],
    ['O(n^2 \\cdot p)', 'O(n² · p)'],
    ['n < 50{,}000', 'n < 50,000'],
    ['r = 0.6', 'r = 0.6'],
    ['\\sum_{i=1}^{n} x_i', '∑ᵢ₌₁ⁿ xᵢ'],
  ])('%s becomes %s', (tex, want) => {
    const r = inlineMathToText(tex);
    expect(r.faithful).toBe(true);
    expect(r.text).toBe(want);
  });

  test('a symbol the face cannot draw falls back to a spelling, not a box', () => {
    // Inter has no glyph for U+2223 (\mid) or U+2208 (\in).
    expect(inlineMathToText('E[X_j \\mid X_{-j}]').text).toBe('E[Xⱼ | X₋ⱼ]');
    expect(inlineMathToText('P(x) \\in S').text).toBe('P(x) in S');
  });

  test('escaped braces and underscores survive', () => {
    // Unescaping them before the brace-strip and subscript passes deleted
    // set notation and turned a literal `_` into a subscript.
    expect(inlineMathToText('P(x) \\in \\{0, 1\\}').text).toBe('P(x) in {0, 1}');
    expect(inlineMathToText('x\\_1').text).toBe('x_1');
  });
});

describe('the faithful escape hatch', () => {
  test.each([
    '\\frac{a}{b}',
    '\\cfrac{1}{2}',
    '\\sqrt{x}',
    '\\tbinom{n}{2}',
    '\\hat{y}',
    '\\bar{x}',
    '\\vec{v}',
    '\\mathbb{R}',
    '\\overline{AB}',
    '\\operatorname{sign}(x)',
  ])('%s is reported unfaithful and keeps its source', (tex) => {
    const r = inlineMathToText(tex);
    expect(r.faithful).toBe(false);
    // Crucially NOT a bare English word: `\\cfrac{1}{2}` once became
    // "cfrac 12", which reads as the integer twelve.
    expect(r.text).toBe(tex.trim());
  });

  test.each([
    ['e^{2x}', 'e^2x'],
    ['x^{ab}', 'x^ab'],
    ['e^{1.4 \\ln 2.5}', 'e^1.4'],
  ])('%s is unfaithful rather than losing its grouping', (tex) => {
    // Stripping the braces turns `e^{2x}` into `e^2x`, which reads as
    // e² · x — a DIFFERENT expression, printed as if it were correct.
    const r = inlineMathToText(tex);
    expect(r.faithful).toBe(false);
    expect(r.text).toBe(tex.trim());
  });

  test('a mappable braced script still converts', () => {
    expect(inlineMathToText('x^{12}')).toEqual({ text: 'x¹²', faithful: true });
    expect(inlineMathToText('x_{-j}')).toEqual({ text: 'x₋ⱼ', faithful: true });
  });

  test('an unknown command never becomes a bare word', () => {
    const r = inlineMathToText('\\notacommand{x}');
    expect(r.faithful).toBe(false);
    expect(r.text).not.toBe('notacommand x');
  });
});
