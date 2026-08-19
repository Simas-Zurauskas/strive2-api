/**
 * Phase 2b — `mindmap` → `flowchart LR`.
 *
 * The lead assertion here compares LABEL CONTENT extracted from the
 * rendered SVG against the source labels. That is deliberate and it is the
 * whole point of the file.
 *
 * An earlier draft asserted that the `<text>` element COUNT matched the
 * node count. Every one of the seven production mindmaps passed. It was
 * still silently deleting text: `root("Design Patterns (GoF)")` rendered
 * as `"Design Patterns (GoF`, and the bare label
 * `Regression (continuous output)` rendered as `continuous output` — the
 * word "Regression" gone from the learner's PDF. The counts were right in
 * both cases, because a truncated label is still one `<text>` element.
 *
 * Both inputs are reachable by design, not by accident:
 * `lib/ai/agents/lessonGeneration/prompts.ts:158` tells the model to quote
 * labels containing parentheses, and the prompt's own worked mindmap
 * example uses bare child labels.
 */

import { describe, test, expect } from 'vitest';
import { CONTENT_HEIGHT, CONTENT_WIDTH } from './theme';
import { escapeLabel, mindmapToFlowchart, stripShape } from './mindmap';
import { renderDiagram } from './mermaid';
import { PROD_MINDMAPS, PROD_MINDMAP_SKAICIAI } from './__fixtures__/diagrams';

/** Text content of every `<text>` element, entity-decoded. */
const renderedLabels = (svg: string): string[] =>
  [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim(),
    )
    .filter(Boolean);

/** What the labels SHOULD be, derived from the source the same way. */
const sourceLabels = (source: string): string[] =>
  source
    .split('\n')
    .slice(1)
    .filter((l) => l.trim() && !l.trim().startsWith('%%'))
    .map((l) => escapeLabel(stripShape(l)))
    .filter(Boolean);

const renderMindmap = async (source: string) => {
  const r = await renderDiagram({ source });
  if (!r.ok) throw new Error(`expected ok, got reason=${r.reason}`);
  return r;
};

// ── 1. LABEL FIDELITY ──────────────────────────────────────

describe('label fidelity — every source label reaches the page', () => {
  test.each(PROD_MINDMAPS.map((m) => [m.name, m.source, m.nodes] as const))(
    'production mindmap: %s',
    async (_name, source, nodes) => {
      const r = await renderMindmap(source);
      const want = sourceLabels(source);
      expect(want).toHaveLength(nodes); // the fixture's stated size is real
      const got = renderedLabels(r.svg);
      expect(got.filter((g) => !want.includes(g))).toEqual([]); // nothing invented
      expect(want.filter((w) => !got.includes(w))).toEqual([]); // nothing lost
    },
  );

  // Each of these rendered WRONGLY before the fix, with the <text> count
  // still correct — which is why counting was not enough.
  test.each([
    [
      'quoted root containing a parenthetical',
      'mindmap\n  root("Design Patterns (GoF)")\n    Creational\n    Structural',
      'Design Patterns (GoF)',
    ],
    [
      'bare label with a parenthetical gloss',
      'mindmap\n  root("Supervised Learning")\n    Regression (continuous output)',
      'Regression (continuous output)',
    ],
    [
      'bare label with brackets',
      'mindmap\n  root("Arrays")\n    Index range [0, n-1]',
      'Index range (0, n-1)', // [ ] fold to ( ) — documented, meaning-preserving
    ],
    [
      'label containing double quotes',
      'mindmap\n  root("The "best" idea")\n    child',
      'The "best" idea',
    ],
    [
      'icon decoration is dropped, the label is not',
      'mindmap\n  root("Reading")\n    C::icon(fa fa-book)',
      'C',
    ],
  ])('%s', async (_name, source, mustAppear) => {
    const r = await renderMindmap(source);
    expect(renderedLabels(r.svg)).toContain(mustAppear);
  });

  test('a %% comment produces no node at all', async () => {
    const source = 'mindmap\n  root("Intake")\n    %% this branch is about intake\n    Triage';
    const r = await renderMindmap(source);
    const labels = renderedLabels(r.svg);
    expect(labels).toEqual(expect.arrayContaining(['Intake', 'Triage']));
    expect(labels.some((l) => l.includes('%%'))).toBe(false);
    expect(labels).toHaveLength(2);
  });
});

// ── 2-3. shape of the emitted source ───────────────────────

describe('the emitted flowchart source', () => {
  test.each(PROD_MINDMAPS.map((m) => [m.name, m.source] as const))(
    'starts with `flowchart LR`: %s',
    (_name, source) => {
      expect(mindmapToFlowchart(source)?.split('\n')[0]).toBe('flowchart LR');
    },
  );

  test.each(PROD_MINDMAPS.map((m) => [m.name, m.source, m.nodes] as const))(
    'is a tree, square-shaped throughout: %s',
    (_name, source, nodes) => {
      const fc = mindmapToFlowchart(source)!;
      const nodeLines = fc.split('\n').filter((l) => /^\s+m\d+\[/.test(l));
      const edgeLines = fc.split('\n').filter((l) => /-->/.test(l));
      expect(nodeLines).toHaveLength(nodes);
      expect(edgeLines).toHaveLength(nodes - 1); // tree, not forest
      // No round-shaped node survives — that shape truncates on `)`.
      expect(fc.split('\n').filter((l) => /^\s+m\d+\(/.test(l))).toEqual([]);
    },
  );
});

// ── 4. hierarchy ───────────────────────────────────────────

describe('hierarchy is preserved, not flattened', () => {
  test('a grandchild hangs off its parent, not off the root', () => {
    const fc = mindmapToFlowchart(PROD_MINDMAP_SKAICIAI)!;
    const idOf = (label: string) => {
      const line = fc.split('\n').find((l) => l.includes(`["${label}"]`));
      return /^\s+(m\d+)\[/.exec(line ?? '')?.[1];
    };
    const root = idOf('Skaičiai 11–20');
    const desimtukas = idOf('Dešimtukas = 10');
    const kaireje = idOf('Visada kairėje');
    expect(root).toBeDefined();
    expect(desimtukas).toBeDefined();
    expect(kaireje).toBeDefined();

    expect(fc).toContain(`${desimtukas} --> ${kaireje}`);
    expect(fc).not.toContain(`${root} --> ${kaireje}`);
  });
});

// ── 5. bare labels ─────────────────────────────────────────

describe('bare (unquoted) labels', () => {
  test('five of the seven production maps use them and all convert', async () => {
    const withBare = PROD_MINDMAPS.filter((m) =>
      m.source.split('\n').slice(1).some((l) => l.trim() && !l.trim().startsWith('"') && !l.trim().startsWith('root(')),
    );
    expect(withBare.length).toBeGreaterThanOrEqual(4);
    for (const m of withBare) {
      const r = await renderMindmap(m.source);
      expect(renderedLabels(r.svg).length).toBe(m.nodes);
    }
  });
});

// ── 6. indentation ─────────────────────────────────────────

describe('indentation', () => {
  // Asserted against an EXPLICIT expected hierarchy. Comparing a tab source
  // to its own space-indented twin was tautological: deleting the tab
  // handling entirely left that comparison green.
  test('a tab-indented source produces the stated parent -> child edges', () => {
    const fc = mindmapToFlowchart('mindmap\n\troot("R")\n\t\tChild A\n\t\t\tGrand A1\n\t\tChild B')!;
    const lines = fc.split('\n');
    const id = (label: string) => /^\s+(m\d+)\[/.exec(lines.find((l) => l.includes(`["${label}"]`)) ?? '')?.[1];
    expect(fc).toContain(`${id('R')} --> ${id('Child A')}`);
    expect(fc).toContain(`${id('Child A')} --> ${id('Grand A1')}`);
    expect(fc).toContain(`${id('R')} --> ${id('Child B')}`);
    expect(fc).not.toContain(`${id('R')} --> ${id('Grand A1')}`);
    expect(lines.filter((l) => /-->/.test(l))).toHaveLength(3);
  });
});

// ── 7-8. routing and refusal ───────────────────────────────

describe('routing and refusal', () => {
  test('an empty body returns null and renderDiagram reports ok:false', async () => {
    expect(mindmapToFlowchart('mindmap')).toBeNull();
    await expect(renderDiagram({ source: 'mindmap' })).resolves.toMatchObject({ ok: false });
  });

  test('a comment-only body returns null', async () => {
    expect(mindmapToFlowchart('mindmap\n  %% nothing here')).toBeNull();
    await expect(renderDiagram({ source: 'mindmap\n  %% nothing here' })).resolves.toMatchObject({
      ok: false,
    });
  });

  test('leading whitespace before `mindmap` still routes to the transposition', async () => {
    // Without a trim this reaches the native renderer, which rejects the
    // mindmap header, and a real diagram silently becomes a placeholder.
    const r = await renderDiagram({ source: '\n  ' + PROD_MINDMAP_SKAICIAI });
    expect(r.ok).toBe(true);
  });
});

// ── 9. fit ─────────────────────────────────────────────────

describe('page fit', () => {
  test.each(PROD_MINDMAPS.map((m) => [m.name, m.source] as const))(
    'fits the content box on BOTH axes: %s',
    async (_name, source) => {
      const r = await renderMindmap(source);
      expect(r.width).toBeLessThanOrEqual(CONTENT_WIDTH + 0.01);
      expect(r.height).toBeLessThanOrEqual(CONTENT_HEIGHT + 0.01);
    },
  );
});
