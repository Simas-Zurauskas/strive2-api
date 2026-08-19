/**
 * Mermaid source → a self-contained SVG that pdfmake can actually draw.
 *
 * `beautiful-mermaid` lays diagrams out correctly but emits an SVG that
 * leans on three things no PDF consumer supports:
 *
 *   <svg style="--bg:#faf9f7;--fg:#0f172a;…">
 *   <style>
 *     @import url('https://fonts.googleapis.com/css2?family=Inter…');
 *     svg { --_node-fill: var(--surface, color-mix(in srgb, var(--fg) 3%, var(--bg))); … }
 *   </style>
 *   <rect fill="var(--_node-fill)" stroke="var(--_node-stroke)" />
 *
 * i.e. CSS custom properties, `color-mix()`, and a remote `@import`. Fed
 * straight to pdfmake every node comes out a solid black box with invisible
 * text; rasterising the same SVG with sharp/librsvg fails identically, so
 * this is not a pdfmake problem and there is no consumer to switch to. We
 * resolve the variables ourselves and drop the `<style>` element — which
 * also removes the outbound network reference from generated content.
 *
 * The library is ESM-only and this package is CommonJS, so it is reached
 * through `await import()`. TypeScript with `module: NodeNext` preserves
 * that rather than downlevelling it to `require()`, and it works under
 * ts-node and vitest too.
 */

import { CONTENT_HEIGHT, CONTENT_WIDTH, COLORS } from './theme';
import { mindmapToFlowchart } from './mindmap';
import { pdfLog } from '@lib/loggers';

export type DiagramResult =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; reason: 'degenerate' | 'error' };

/** Palette handed to the renderer. Mirrors the app's light theme. */
const PALETTE = {
  bg: COLORS.background,
  fg: COLORS.foreground,
  // Deliberately darker than `COLORS.border`: connector lines at 0.5pt need
  // more contrast on paper than a hairline does on screen.
  line: '#b8b0a8',
  accent: COLORS.accent,
  muted: COLORS.muted,
  surface: COLORS.surface,
  border: COLORS.border,
  font: 'Inter',
  padding: 10,
  transparent: true,
} as const;

// ── CSS variable resolution ────────────────────────────────

const hexToRgb = (c: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
};

const rgbToHex = ([r, g, b]: [number, number, number]): string =>
  '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/** `color-mix(in srgb, A p%, B)` — a straight sRGB blend, p% of A. */
const colorMix = (a: string, pct: number, b: string): string | null => {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return null;
  const t = pct / 100;
  return rgbToHex([0, 1, 2].map((i) => A[i] * t + B[i] * (1 - t)) as [number, number, number]);
};

/** Split on top-level commas, respecting nested parens. */
const splitTopLevel = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
};

/** Resolve one CSS colour expression to a literal hex, or null. */
const resolveColor = (expr: string, vars: Record<string, string>, seen = new Set<string>()): string | null => {
  const e = expr.trim();
  if (hexToRgb(e)) return e;

  const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/.exec(e);
  if (varMatch) {
    const [, name, fallback] = varMatch;
    if (seen.has(name)) return null; // cyclic definition
    const next = new Set(seen).add(name);
    if (vars[name] !== undefined) {
      const r = resolveColor(vars[name], vars, next);
      if (r) return r;
    }
    return fallback ? resolveColor(fallback, vars, next) : null;
  }

  const mixMatch = /^color-mix\(\s*in\s+srgb\s*,([\s\S]*)\)$/.exec(e);
  if (mixMatch) {
    const parts = splitTopLevel(mixMatch[1]);
    if (parts.length !== 2) return null;
    const pm = /^([\s\S]+?)\s+([\d.]+)%$/.exec(parts[0]);
    if (!pm) return null;
    const a = resolveColor(pm[1], vars, seen);
    const b = resolveColor(parts[1], vars, seen);
    if (!a || !b) return null;
    return colorMix(a, parseFloat(pm[2]), b);
  }
  return null;
};

/**
 * Attributes that can legitimately carry a colour. Resolution is scoped to
 * these and nothing else.
 *
 * The obvious implementation — scan the whole SVG string for `var(` — is
 * WRONG, and silently so. `<text>` bodies and `data-label` attributes carry
 * learner-visible content, and a label is free to contain the substring
 * `var(`: `covar(X, Y)` is ordinary notation in the statistics domain the
 * generator explicitly targets. A document-wide scan rewrote
 * `Compute covar(X, Y)` to `Compute conone`, and an unbalanced parenthesis
 * ran the scan to end-of-file, replacing the rest of the document — closing
 * `</svg>` included — with `none`.
 */
const PAINT_ATTRS = 'fill|stroke|style|color|stop-color|flood-color|lighting-color';
const PAINT_ATTR_RE = new RegExp(`\\s(${PAINT_ATTRS})="([^"]*)"`, 'g');

/**
 * Resolve every `var()` / `color-mix()` inside ONE attribute value.
 *
 * The paren balance scan is bounded by the value, so an unterminated
 * expression can corrupt at most that attribute — never the document. An
 * expression that does not balance, or does not resolve, increments
 * `unresolved`, which the caller treats as a failure.
 */
const resolveInValue = (
  value: string,
  vars: Record<string, string>,
): { value: string; unresolved: number } => {
  if (!/(?:var|color-mix)\(/.test(value)) return { value, unresolved: 0 };

  let out = '';
  let i = 0;
  let unresolved = 0;
  const START = /(?:^|[\s,:(])((?:var|color-mix)\()/g;
  START.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = START.exec(value)) !== null) {
    const exprStart = m.index + m[0].length - m[1].length;
    if (exprStart < i) continue;
    out += value.slice(i, exprStart);

    let depth = 0;
    let end = exprStart;
    let balanced = false;
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++;
      else if (value[end] === ')') {
        depth--;
        if (depth === 0) {
          balanced = true;
          break;
        }
      }
    }
    if (!balanced) {
      unresolved++;
      out += value.slice(exprStart);
      i = value.length;
      break;
    }

    const literal = resolveColor(value.slice(exprStart, end + 1), vars);
    if (literal) {
      out += literal;
    } else {
      unresolved++;
      out += 'none';
    }
    i = end + 1;
    START.lastIndex = i;
  }
  out += value.slice(i);
  return { value: out, unresolved };
};

/**
 * Rewrite every `var(...)` / `color-mix(...)` in a PAINT ATTRIBUTE to a
 * literal hex, then delete the `<style>` element and the now-dead custom
 * properties.
 *
 * Variable definitions are read out of the emitted SVG at runtime rather
 * than hard-coded, so a library upgrade that renames its internal `--_*`
 * names shows up as a non-zero `unresolved` — which `renderDiagram` refuses
 * on — instead of a silently mis-coloured diagram.
 */
export const flattenSvg = (svg: string, fontFamily = 'Inter'): { svg: string; unresolved: number } => {
  const vars: Record<string, string> = {};

  const rootStyle = /<svg[^>]*\sstyle="([^"]*)"/.exec(svg)?.[1] ?? '';
  for (const decl of rootStyle.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+)$/.exec(decl);
    if (m) vars[m[1]] = m[2].trim();
  }
  const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? '';
  for (const m of styleBlock.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
    vars[m[1]] = m[2].trim();
  }

  let unresolved = 0;

  // Only paint attributes are touched. Text content and data-* attributes
  // are left exactly as the renderer emitted them.
  let out = svg.replace(PAINT_ATTR_RE, (all: string, name: string, value: string) => {
    const r = resolveInValue(value, vars);
    unresolved += r.unresolved;
    return r.value === value ? all : ` ${name}="${r.value}"`;
  });

  // Drop the <style> element — this is what removes the Google Fonts
  // @import, i.e. an outbound network reference embedded in LLM-generated
  // content, as well as the now-meaningless custom-property declarations.
  out = out.replace(/<style>[\s\S]*?<\/style>/g, '');
  out = out.replace(/(<svg[^>]*\sstyle=")([^"]*)(")/, (_all, a: string, decls: string, c: string) => {
    const kept = decls.split(';').filter((d) => d.trim() && !d.trim().startsWith('--'));
    return `${a}${kept.join(';')}${c}`;
  });
  out = out.replace(/font-family\s*=\s*"[^"]*"/g, `font-family="${fontFamily}"`);

  return { svg: out, unresolved };
};

// ── degeneracy ─────────────────────────────────────────────

/**
 * `beautiful-mermaid` never throws on bad input — it returns a small,
 * meaningless SVG. A byte-size threshold cannot separate that from a
 * legitimately small diagram (a real two-node flowchart is well under the
 * size of a garbage render), so the signal is structural:
 *
 *   - zero `<text>` elements  → nothing was laid out at all
 *   - flowchart family with zero edges AND zero nodes parsed → the source
 *     said nothing the parser recognised
 *
 * `parseMermaid` only understands the flowchart family and throws for
 * sequence/class/state/er, so its verdict is used only when it succeeds.
 */
const isDegenerate = (flattened: string, parsed: { nodes?: object; edges?: unknown[] } | null): boolean => {
  const textCount = (flattened.match(/<text/g) ?? []).length;
  if (textCount === 0) return true;
  if (parsed) {
    const nodeCount = parsed.nodes ? Object.keys(parsed.nodes).length : 0;
    const edgeCount = parsed.edges?.length ?? 0;
    if (nodeCount === 0 && edgeCount === 0) return true;
  }
  return false;
};

// ── public entry point ─────────────────────────────────────

const attr = (svg: string, name: string): number =>
  parseFloat(new RegExp(`\\s${name}="([\\d.]+)"`).exec(svg)?.[1] ?? '0');

/**
 * Render one mermaid block to an SVG sized for the page.
 *
 * Scaling is bounded on BOTH axes and never exceeds 1 — an `LR` tree trades
 * width for height, and a width-only rule let a real 21-node diagram end up
 * 191 pt taller than the content box.
 */
export const renderDiagram = async ({
  source,
  maxWidth = CONTENT_WIDTH,
  maxHeight = CONTENT_HEIGHT,
}: {
  source: string;
  maxWidth?: number;
  maxHeight?: number;
}): Promise<DiagramResult> => {
  const trimmed = source.trimStart();

  // `mindmap` is the one type the renderer rejects outright. It is an
  // indentation-defined tree, so it is transposed to a flowchart first.
  const effective = trimmed.toLowerCase().startsWith('mindmap')
    ? mindmapToFlowchart(trimmed)
    : trimmed;
  if (!effective) return { ok: false, reason: 'degenerate' };

  try {
    const { renderMermaidSVG, parseMermaid } = await import('beautiful-mermaid');

    const raw = renderMermaidSVG(effective, PALETTE);
    const { svg, unresolved } = flattenSvg(raw, 'Inter');

    let parsed: { nodes?: object; edges?: unknown[] } | null = null;
    try {
      parsed = parseMermaid(effective) as { nodes?: object; edges?: unknown[] };
    } catch {
      parsed = null; // not the flowchart family — structural check falls back to <text>
    }

    if (isDegenerate(svg, parsed)) return { ok: false, reason: 'degenerate' };

    // An unresolved paint expression means the palette contract with the
    // renderer has broken — most likely an upgrade that renamed its internal
    // `--_*` variables. `none` is a legal SVG paint, so the diagram would
    // still lay out, still contain <text>, still pass the degeneracy check,
    // and ship as a page of invisible boxes. A placeholder line is better
    // than that, and the log line says which.
    if (unresolved > 0) {
      pdfLog.error(`diagram:unresolved-paint count=${unresolved} — refusing to embed`);
      return { ok: false, reason: 'error' };
    }

    const w = attr(svg, 'width');
    const h = attr(svg, 'height');
    if (!(w > 0) || !(h > 0)) return { ok: false, reason: 'degenerate' };

    const scale = Math.min(maxWidth / w, maxHeight / h, 1);
    return { ok: true, svg, width: w * scale, height: h * scale };
  } catch (e) {
    pdfLog.error(`diagram:render-failed msg=${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, reason: 'error' };
  }
};
