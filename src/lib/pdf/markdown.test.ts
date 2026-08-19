/**
 * Phase 4 — markdown → pdfmake content.
 *
 * The assertions look at the emitted NODE, not at a serialised blob,
 * because "the string `## Heading` is absent" is satisfied by dropping the
 * line entirely. What matters is that a heading became a heading.
 */

import { describe, test, expect } from 'vitest';
import type { Content } from 'pdfmake/interfaces';
import { markdownToContent } from './markdown';

/** Flatten every string that would be drawn, for absence/presence checks. */
const allText = (nodes: Content[] | Content): string => JSON.stringify(nodes);

/** First node whose `style` matches. */
const byStyle = (nodes: Content[], style: string): Content | undefined =>
  nodes.find((n) => (n as { style?: string }).style === style);

const tables = (nodes: Content[]) => nodes.filter((n) => 'table' in (n as object));

describe('headings', () => {
  test('`## Heading` becomes a styled heading, not literal text', () => {
    const out = markdownToContent('## The Three Mechanisms\n\nBody text.');
    const h = byStyle(out, 'h2') as { text?: string };
    expect(h).toBeDefined();
    expect(h.text).toBe('The Three Mechanisms');
    expect(allText(out)).not.toContain('##');
  });

  test('deeper headings get their own style', () => {
    const out = markdownToContent('#### Deep');
    expect(byStyle(out, 'h3')).toBeDefined();
  });
});

describe('inline emphasis', () => {
  test('**bold** becomes a bold run and loses its markers', () => {
    const out = markdownToContent('This is **very** important.');
    expect(allText(out)).toContain('"bold":true');
    expect(allText(out)).not.toContain('**');
  });

  test('*italic* becomes an italic run', () => {
    const out = markdownToContent('This is *subtle* emphasis.');
    expect(allText(out)).toContain('"italics":true');
  });

  test('`inline code` keeps its content and drops the backticks', () => {
    const out = markdownToContent('Call `fit_transform` on it.');
    const s = allText(out);
    expect(s).toContain('fit_transform');
    expect(s).not.toContain('`');
  });

  test('a link keeps its label and carries the href', () => {
    const out = markdownToContent('See [the docs](https://example.com/x) for more.');
    const s = allText(out);
    expect(s).toContain('the docs');
    expect(s).toContain('https://example.com/x');
    expect(s).not.toContain('](');
  });
});

describe('lists', () => {
  test('a bullet list becomes a ul with one item per bullet', () => {
    const out = markdownToContent('- alpha\n- beta\n- gamma');
    const ul = out.find((n) => 'ul' in (n as object)) as { ul: unknown[] };
    expect(ul).toBeDefined();
    expect(ul.ul).toHaveLength(3);
  });

  test('an ordered list becomes an ol', () => {
    const out = markdownToContent('1. first\n2. second');
    const ol = out.find((n) => 'ol' in (n as object)) as { ol: unknown[] };
    expect(ol).toBeDefined();
    expect(ol.ol).toHaveLength(2);
  });

  // A fixture where every nested item hangs off the FIRST outer item cannot
  // detect relocation — the buggy output and the correct one look the same.
  // These interleave, and assert reading ORDER.
  test('a nested item stays attached to its own parent', () => {
    const out = markdownToContent('- Step 1\n  - detail A\n- Step 2\n  - detail B\n- Step 3');
    const order = [...allText(out).matchAll(/"(Step \d|detail [AB])"/g)].map((m) => m[1]);
    expect(order).toEqual(['Step 1', 'detail A', 'Step 2', 'detail B', 'Step 3']);
  });

  // A child block whose FIRST line has no marker used to make `buildList`
  // recurse on itself until the depth cap: two lines of ordinary markdown
  // produced 13 nested lists and 12 empty bullets, occupying 457 pt of a
  // 697 pt column.
  test('a lazy continuation line joins its item instead of exploding', () => {
    const out = markdownToContent(
      '- **Bias** — systematic error\n  It does not shrink with more data.\n- **Variance** — sensitivity.',
    );
    const j = allText(out);
    expect((j.match(/"ul"/g) ?? []).length).toBe(1);
    expect(j).not.toContain('"text":""');
    expect(j).toContain('It does not shrink with more data.');
    const ul = out.find((n) => 'ul' in (n as object)) as { ul: unknown[] };
    expect(ul.ul).toHaveLength(2);
  });

  test('an indented code fence under an item does not explode either', () => {
    const out = markdownToContent('- Run this:\n  ```py\n  print(1)\n  ```\n- Then stop.');
    expect((allText(out).match(/"ul"/g) ?? []).length).toBeLessThanOrEqual(2);
    expect(allText(out)).not.toContain('"text":""');
  });

  // pdfmake restarts every `ol` at 1, so splitting a list on a lazy
  // continuation printed "1. one / two continues / 1. three".
  test('a lazy continuation does not split an ordered list and restart numbering', () => {
    const out = markdownToContent('1. one\ntwo continues\n2. three');
    expect((allText(out).match(/"ol"/g) ?? []).length).toBe(1);
    const ol = out.find((n) => 'ol' in (n as object)) as { ol: unknown[] };
    expect(ol.ol).toHaveLength(2);
  });

  // pdfmake starts every `ol` at 1, so splitting a "loose" list (blank lines
  // between items) printed a numbered procedure as "1. … 1. … 1.". 58 of
  // 2358 production blocks contain one, including numbered exercise steps.
  test('a blank line between items keeps ONE ordered list', () => {
    const out = markdownToContent('1. first step\n\n2. second step\n\n3. third step');
    expect((allText(out).match(/"ol"/g) ?? []).length).toBe(1);
    const ol = out.find((n) => 'ol' in (n as object)) as { ol: unknown[] };
    expect(ol.ol).toHaveLength(3);
  });

  test('a blank line between items keeps ONE bullet list', () => {
    const out = markdownToContent('- alpha\n\n- beta\n\n- gamma');
    const ul = out.find((n) => 'ul' in (n as object)) as { ul: unknown[] };
    expect(ul.ul).toHaveLength(3);
  });

  test('a blank line followed by PROSE still ends the list', () => {
    const out = markdownToContent('- alpha\n- beta\n\nA new paragraph.');
    const ul = out.find((n) => 'ul' in (n as object)) as { ul: unknown[] };
    expect(ul.ul).toHaveLength(2);
    expect(allText(out)).toContain('A new paragraph.');
    // The paragraph must be its own node, not a third bullet.
    expect(JSON.stringify(ul.ul)).not.toContain('A new paragraph.');
  });

  test('an indented fence under an item stays a code block, not prose', () => {
    const out = markdownToContent('- Run this:\n  ```py\n  def f():\n      return 1\n  ```\n- Then stop.');
    const s = allText(out);
    // Rendered as code, with its indentation intact — not joined into the
    // bullet's prose with spaces and stray backticks.
    expect(s).toContain('codeBody');
    expect(s).toContain('preserveLeadingSpaces');
    // The list's own 2-space indent is stripped; the code's RELATIVE
    // indentation survives, which is the part that carries meaning.
    expect(s).toContain('def f():\\n    return 1');
    expect(s).not.toContain('``');
  });

  test.each([
    ['a heading', '- a\n- b\n## Next'],
    ['a rule', '- a\n- b\n---'],
    ['a fence', '- a\n- b\n```py\nx\n```'],
  ])('%s still ends the list', (_n, md) => {
    const out = markdownToContent(md);
    expect(out.length).toBeGreaterThan(1);
  });

  test('a nested list is a nested node, not a sibling run', () => {
    const out = markdownToContent('- outer one\n  - inner a\n  - inner b\n- outer two');
    const ul = out.find((n) => 'ul' in (n as object)) as { ul: unknown[] };
    expect(ul.ul).toHaveLength(2); // two outer items, not four
    expect(allText(out)).toContain('inner a');
  });
});

describe('code blocks', () => {
  test('leading indentation survives — pdfmake trims it unless told not to', () => {
    // Monospace alone does not save an indented block: without
    // `preserveLeadingSpaces` pdfmake strips the leading spaces on every
    // line, and Python stops being Python.
    const out = markdownToContent('```python\ndef f():\n    return 1\n```');
    const s = JSON.stringify(out);
    expect(s).toContain('preserveLeadingSpaces');
    expect(s).toContain('    return 1');
  });

  test('a fenced block renders as a code node, not as prose', () => {
    const out = markdownToContent('Intro.\n\n```python\nx = 1\nprint(x)\n```\n\nOutro.');
    const s = allText(out);
    expect(s).toContain('codeBody');
    expect(s).toContain('PYTHON');
    expect(s).toContain('print(x)');
    expect(s).not.toContain('```');
  });
});

describe('blockquotes and rules', () => {
  test('a blockquote becomes a quote-styled node', () => {
    const out = markdownToContent('> remember this');
    expect(byStyle(out, 'quote')).toBeDefined();
  });

  test('a horizontal rule becomes a drawn line', () => {
    const out = markdownToContent('before\n\n---\n\nafter');
    expect(out.some((n) => 'canvas' in (n as object))).toBe(true);
  });
});

describe('GFM tables', () => {
  // Verbatim from a production `section` block (BITSAT lesson).
  const PROD_TABLE = `## The Exact Architecture

Here is the exact distribution you must internalize:

| Section | Questions | Max Marks |
|---|---|---|
| Physics | 40 | 120 |
| Chemistry | 40 | 120 |
| Mathematics | 45 | 135 |
| Logical Reasoning | 25 | 75 |`;

  test('a production pipe table becomes a real table node', () => {
    const out = markdownToContent(PROD_TABLE);
    const t = tables(out)[0] as { table: { body: unknown[][]; widths: unknown[] } };
    expect(t).toBeDefined();
    expect(t.table.widths).toHaveLength(3);
    expect(t.table.body).toHaveLength(5); // header + 4 rows
  });

  test('the delimiter row never reaches the page as text', () => {
    const out = markdownToContent(PROD_TABLE);
    expect(allText(out)).not.toContain('|---|');
    expect(allText(out)).not.toContain('| Physics |');
  });

  test('cell contents survive', () => {
    const s = allText(markdownToContent(PROD_TABLE));
    expect(s).toContain('Logical Reasoning');
    expect(s).toContain('135');
  });

  test(':---: alignment markers produce centred columns', () => {
    const out = markdownToContent('| a | b |\n|:---:|---:|\n| 1 | 2 |');
    const t = tables(out)[0] as { table: { body: { alignment?: string }[][] } };
    expect(t.table.body[0][0].alignment).toBe('center');
    expect(t.table.body[0][1].alignment).toBe('right');
  });

  test('maths inside a cell is typeset, not printed as $ source', () => {
    // From the production Lithuanian arithmetic exercise. The previous
    // version of this test was named for this behaviour but asserted only
    // that a table existed — and the behaviour did not exist.
    const out = markdownToContent('| Pirma dalis | Sudėtis |\n|:---:|:---:|\n| $1$ | $1 + 2 = 3$ |');
    expect(tables(out)).toHaveLength(1);
    const s = allText(out);
    expect(s).toContain('1 + 2 = 3');
    expect(s).not.toContain('$1 + 2 = 3$');
    expect(s).not.toContain('$1$');
  });
});

describe('maths', () => {
  test('display maths becomes a centred svg node', () => {
    const out = markdownToContent('Because:\n\n$$P(M) = 1$$\n\nwe conclude.');
    const svgNode = out.find((n) => 'svg' in (n as object)) as { alignment?: string };
    expect(svgNode).toBeDefined();
    expect(svgNode.alignment).toBe('center');
  });

  test('a price is NOT treated as maths', () => {
    const out = markdownToContent('It costs $5 today and $9 tomorrow.');
    expect(out.some((n) => 'svg' in (n as object))).toBe(false);
    expect(allText(out)).toContain('$5');
  });

  // Inline maths is TEXT, not an svg node. pdfmake has no inline graphic:
  // an `{svg}` inside a `text` array is not a text leaf, so docMeasure
  // drops it silently — the expression vanishes with no error at all. The
  // bytes-level assertion below is the one that catches that; a node-tree
  // assertion cannot.
  test('inline maths is typeset into the line, not dropped', () => {
    const out = markdownToContent('Let $k = 5$ be the neighbour count.');
    const s = allText(out);
    expect(s).toContain('k = 5');
    expect(s).toContain('be the neighbour count');
    expect(s).not.toContain('"svg"');
  });

  test('inline maths converts TeX to readable notation', () => {
    // The shapes that actually occur inline in production sections.
    const cases: [string, string][] = [
      ['$O(n^2 \\cdot p)$', 'O(n² · p)'],
      // `∣` (U+2223) is NOT in Inter, so it falls back to ASCII `|` rather
      // than rendering as a hollow .notdef box. See inlineMath.test.ts.
      ['$E[X_j \\mid X_{-j}]$', 'E[Xⱼ | X₋ⱼ]'],
      ['$n < 50{,}000$', 'n < 50,000'],
      ['$\\sigma^2$', 'σ²'],
      ['$r = 0.6$', 'r = 0.6'],
    ];
    for (const [src, want] of cases) {
      expect(allText(markdownToContent(`Value ${src} here.`)), src).toContain(want);
    }
  });

  test('an expression Unicode cannot express keeps its source rather than lying', () => {
    // A fraction has real two-dimensional layout. Better to show the source
    // than to print something that reads as a different expression.
    const s = allText(markdownToContent('Given $\\frac{a}{b}$ we conclude.'));
    expect(s).toContain('frac');
    expect(s).toContain('we conclude');
  });

  test('unparseable maths falls back to its source rather than vanishing', () => {
    const out = markdownToContent('Broken $$\\frac{$$ here.');
    expect(allText(out)).toContain('frac');
  });
});

describe('regex state is not shared between calls', () => {
  // `displayMathRe`/`inlineMathRe` are factories precisely so a `.test()`
  // in one call cannot leave `lastIndex` dirty for the next. Converting the
  // same source twice must give identical output.
  test('converting the same markdown twice gives identical output', () => {
    const src = 'First $a = 1$ then $b = 2$ and $$c = 3$$ done.';
    expect(allText(markdownToContent(src))).toBe(allText(markdownToContent(src)));
  });

  test('every inline expression in one paragraph is found, not just the first', () => {
    const s = allText(markdownToContent('Let $a = 1$ and $b = 2$ and $c = 3$.'));
    expect(s).toContain('a = 1');
    expect(s).toContain('b = 2');
    expect(s).toContain('c = 3');
  });
});

describe('link hrefs are scheme-checked', () => {
  // Every href in a lesson is LLM-generated. PDF readers usually refuse
  // javascript: actions, but that is their control, not ours.
  test.each(['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'vbscript:x'])(
    '%s does not become a link annotation',
    (href) => {
      const out = markdownToContent(`See [the docs](${href}) for more.`);
      const s = allText(out);
      expect(s).toContain('the docs'); // label survives
      expect(s).not.toContain('"link"');
    },
  );

  test.each(['https://example.com/x', 'http://example.com/x', 'mailto:a@b.com'])(
    '%s is still linked',
    (href) => {
      expect(allText(markdownToContent(`See [the docs](${href}).`))).toContain('"link"');
    },
  );
});

describe('pathological input cannot take the process down', () => {
  // The nested-list walk re-materialises the tail at every level, so it is
  // O(n^3) in depth. The 50k schema cap that would bound it is NOT enforced
  // on the write path (`jobRunner` uses findOneAndUpdate without
  // runValidators), so a runaway generation can reach thousands of levels —
  // which is a V8 heap abort, not a catchable throw, on a single-instance
  // server.
  test('3000 levels of nesting completes quickly instead of aborting', () => {
    const deep = Array.from({ length: 3000 }, (_, i) => `${' '.repeat(i * 2)}- item ${i}`).join('\n');
    const started = Date.now();
    const out = markdownToContent(deep);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.length).toBeGreaterThan(0);
    // Content is flattened past the cap, not dropped.
    expect(JSON.stringify(out)).toContain('item 2999');
  });

  test('normal nesting is unaffected', () => {
    const out = markdownToContent('- a\n  - b\n    - c');
    expect(JSON.stringify(out)).toContain('c');
  });
});

describe('degradation', () => {
  test('unsupported syntax falls through as text rather than throwing', () => {
    const out = markdownToContent('~~struck~~ and - [ ] a task\n\n<div>raw html</div>');
    expect(out.length).toBeGreaterThan(0);
    expect(allText(out)).toContain('struck');
  });

  test('empty input yields no nodes', () => {
    expect(markdownToContent('')).toEqual([]);
    expect(markdownToContent('   \n\n  ')).toEqual([]);
  });
});
