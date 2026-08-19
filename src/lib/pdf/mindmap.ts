/**
 * `mindmap` → `flowchart LR`.
 *
 * `beautiful-mermaid` renders every diagram type the generator emits except
 * `mindmap`, which it rejects at the header. A mindmap is an
 * indentation-defined tree and the same library draws flowcharts perfectly,
 * so the gap closes by transposing the source rather than by adding a
 * second renderer. That takes production diagram coverage to 112/112.
 *
 * Three details are load-bearing, and each of them was wrong in a first
 * draft that passed on all seven production mindmaps while silently
 * deleting text from labels production had not happened to produce yet.
 *
 * 1. EMISSION SHAPE. Each mermaid node shape terminates at its own closing
 *    delimiter and nothing else, and the library does NOT decode `&#93;` /
 *    `&#41;`, so there is no in-band escape. Measured: `id("…")` breaks on
 *    `)`; `id["…"]` breaks only on `]`. Since the generator prompt tells
 *    the model to quote labels containing parentheses
 *    (`lib/ai/agents/lessonGeneration/prompts.ts:158`), the round shape
 *    turns `root("Design Patterns (GoF)")` into `"Design Patterns (GoF`.
 *    So: square everywhere, and `[` `]` inside a label fold to `(` `)`.
 *    The cost is the rounded root shape — cosmetic, and worth it.
 *
 * 2. ANCHORED SHAPE-UNWRAP. Searching for a bracket anywhere and checking
 *    the line merely ENDS with the closer turns the bare label
 *    `Regression (continuous output)` into `continuous output` — the word
 *    "Regression" vanishes from the PDF. A mermaid node id cannot contain a
 *    space, so the unwrap is anchored to `^[A-Za-z0-9_-]*` immediately
 *    followed by the opener, and the delimiter must balance at end of line.
 *
 * 3. ORDER. Decorations are stripped BEFORE any shape logic, or
 *    `C::icon(fa fa-book)` is read as a round node and renders as
 *    "fa fa-book".
 */

/** Longest delimiters first so `((` is tried before `(`. */
const SHAPES: readonly (readonly [string, string])[] = [
  ['((', '))'],
  ['{{', '}}'],
  ['[', ']'],
  ['(', ')'],
] as const;

/** True when `body` closes exactly at its end for this delimiter pair. */
const balancedToEnd = (body: string, open: string, close: string): boolean => {
  let depth = 1;
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith(open, i)) {
      depth++;
      i += open.length - 1;
      continue;
    }
    if (body.startsWith(close, i)) {
      depth--;
      if (depth === 0) return i === body.length - close.length;
      i += close.length - 1;
    }
  }
  return false;
};

/** One mindmap line → its plain-text label. */
export const stripShape = (raw: string): string => {
  let s = raw.trim();

  // Before any shape logic — see note 3 above.
  s = s.replace(/::icon\([^)]*\)/g, '').replace(/:::[\w-]+/g, '').trim();

  for (const [open, close] of SHAPES) {
    const opener = new RegExp(`^([A-Za-z0-9_-]*)${open.replace(/[[\]{}()]/g, '\\$&')}`);
    const m = opener.exec(s);
    if (!m) continue;
    const body = s.slice(m[0].length);
    if (!body.endsWith(close)) continue;
    if (!balancedToEnd(body, open, close)) continue;
    s = body.slice(0, body.length - close.length);
    break;
  }

  return s
    .trim()
    .replace(/^"([\s\S]*)"$/, '$1')
    .replace(/^'([\s\S]*)'$/, '$1')
    .trim();
};

/**
 * Make a label safe inside `id["…"]`. `]` is the only character that can
 * terminate it, and there is no entity escape, so it is substituted:
 * `[` `]` fold to `(` `)`, which is meaning-preserving for prose and is
 * proven safe in this shape.
 */
export const escapeLabel = (s: string): string =>
  s.replace(/\[/g, '(').replace(/\]/g, ')').replace(/\r?\n/g, '<br/>');

/**
 * Transpose a mermaid mindmap into a `flowchart LR` source, or return null
 * when there is nothing to draw.
 */
export const mindmapToFlowchart = (source: string): string | null => {
  const lines = source.split('\n');
  const headerIdx = lines.findIndex((l) => l.trim().toLowerCase().startsWith('mindmap'));
  if (headerIdx === -1) return null;

  const nodes: { id: string; label: string }[] = [];
  const edges: [string, string][] = [];
  const stack: { indent: number; id: string }[] = [];

  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    if (line.trim().startsWith('%%')) continue; // mermaid comment
    // 4, matching mermaid's own tab width. At 2 a tab-indented child ties a
    // space-indented root, the stack pops it, and the tree loses its head.
    const expanded = line.replace(/\t/g, '    ');
    const indent = expanded.length - expanded.trimStart().length;
    const label = stripShape(expanded);
    if (!label) continue;

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();

    const id = `m${nodes.length}`;
    nodes.push({ id, label });
    const parent = stack[stack.length - 1];
    if (parent) edges.push([parent.id, id]);
    stack.push({ indent, id });
  }

  if (nodes.length === 0) return null;

  // LR, not TD: a mindmap radiates from a centre, and a left-to-right tree
  // is the closest flowchart reading of that. TD was tried and reads as a
  // process diagram instead.
  const out = ['flowchart LR'];
  for (const node of nodes) out.push(`  ${node.id}["${escapeLabel(node.label)}"]`);
  for (const [a, b] of edges) out.push(`  ${a} --> ${b}`);
  return out.join('\n');
};
