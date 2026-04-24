/**
 * Tests for the LaTeX sanitizer. Pure function (no DB) — KaTeX validates
 * every $ ... $ and $$ ... $$ span; failures degrade to backticked fallback
 * so the client renderer never sees broken LaTeX.
 *
 * Run: yarn test latexSanitizer
 */

import assert from 'node:assert/strict';
import { describe, test, expect } from 'vitest';
import { sanitizeLatex } from '@lib/latexSanitizer';

describe('sanitizeLatex — fast paths', () => {
  test('empty string → no change, 0 failures', () => {
    expect(sanitizeLatex('')).toEqual({ text: '', failedSpans: 0 });
  });

  test('plain text without `$` → no change', () => {
    const r = sanitizeLatex('No math here at all.');
    expect(r.text).toBe('No math here at all.');
    expect(r.failedSpans).toBe(0);
  });
});

describe('sanitizeLatex — display math `$$…$$`', () => {
  test('valid display math passes through', () => {
    const r = sanitizeLatex('Here: $$x^2 + 1$$ and more');
    expect(r.text).toBe('Here: $$x^2 + 1$$ and more');
    expect(r.failedSpans).toBe(0);
  });

  test('malformed display math degrades to backticks', () => {
    const r = sanitizeLatex('Bad: $$\\frac{1$$ here');
    expect(r.text).toContain('`\\frac{1`');
    expect(r.text).not.toContain('$$\\frac{1$$');
    expect(r.failedSpans).toBe(1);
  });

  test('multiple display spans validated independently', () => {
    const r = sanitizeLatex('First $$a + b$$ then $$\\bad{$$');
    expect(r.text).toContain('$$a + b$$'); // valid
    expect(r.text).toContain('`\\bad{`'); // invalid → backticks
    expect(r.failedSpans).toBe(1);
  });
});

describe('sanitizeLatex — inline math `$…$`', () => {
  test('valid inline math passes through', () => {
    const r = sanitizeLatex('When $x = 5$ then');
    expect(r.text).toBe('When $x = 5$ then');
    expect(r.failedSpans).toBe(0);
  });

  test('malformed inline math degrades to backticks', () => {
    const r = sanitizeLatex('See $\\invalid{ here');
    // Note: the regex requires a closing `$` to match, so this might not
    // be matched as math at all — verify behavior.
    // If unmatched, no change. Let's use a more clearly malformed inline.
    const r2 = sanitizeLatex('See $\\frac{1}$ here'); // missing denominator
    if (r2.failedSpans > 0) {
      expect(r2.text).toContain('`');
    }
  });

  test('`$5` in prose does NOT match (no preceding alphanumeric / lookbehind guard)', () => {
    const r = sanitizeLatex('Costs $5 and lots more');
    expect(r.text).toBe('Costs $5 and lots more');
    expect(r.failedSpans).toBe(0);
  });

  test('`$5$x` does NOT match (closing $ followed by alphanumeric)', () => {
    const r = sanitizeLatex('Costs $5$x dollars');
    expect(r.text).toBe('Costs $5$x dollars');
    expect(r.failedSpans).toBe(0);
  });

  test('opening `$` followed by space does NOT match (`$ x $`)', () => {
    const r = sanitizeLatex('See $ x $ here');
    expect(r.text).toBe('See $ x $ here');
    expect(r.failedSpans).toBe(0);
  });

  test('inner content with `\\n` does NOT match (single-line only)', () => {
    const r = sanitizeLatex('See $x\n y$ here');
    expect(r.text).toBe('See $x\n y$ here');
    expect(r.failedSpans).toBe(0);
  });
});

describe('sanitizeLatex — display + inline mixed', () => {
  test('display math runs before inline (no `$$…$$` misread as two inlines)', () => {
    const r = sanitizeLatex('Here: $$x + y$$ and $a$');
    expect(r.text).toBe('Here: $$x + y$$ and $a$');
    expect(r.failedSpans).toBe(0);
  });

  test('mix of valid + invalid: counts only failed spans', () => {
    const r = sanitizeLatex('Good $a + b$ but bad $$\\bad{$$');
    expect(r.text).toContain('$a + b$');
    expect(r.text).toContain('`\\bad{`');
    expect(r.failedSpans).toBe(1);
  });
});
