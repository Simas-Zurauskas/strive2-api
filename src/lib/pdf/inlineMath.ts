/**
 * Inline maths, rendered as text.
 *
 * WHY NOT SVG. pdfmake has no inline graphic. An `{ svg }` node inside a
 * `text` array is not a text leaf, so `docMeasure` drops it silently — no
 * throw, no warning, the expression simply disappears from the page. That
 * was shipped and measured: a paragraph with `$k = 5$` produced a PDF
 * twelve bytes larger than the same paragraph with the maths deleted.
 * Display maths (`$$…$$`) is fine, because it is its own block node.
 *
 * So inline expressions are typeset as Unicode text instead. That is not a
 * downgrade for the shapes that actually occur inline — measured over
 * production `section` blocks, inline maths is things like `r = 0.6`,
 * `k = 5`, `n < 50{,}000`, `O(n^2 \cdot p)`, `E[X_j \mid X_{-j}]`. Unicode
 * renders every one of those properly, in the surrounding line, which is
 * what a typesetter would do anyway. Authors reach for `$$…$$` when they
 * want a displayed fraction, and that path still gets the full MathJax SVG.
 *
 * Anything this cannot represent faithfully — a fraction, a radical, a
 * matrix — reports `faithful: false` so the caller can promote it to a
 * display block rather than print something subtly wrong.
 */

/**
 * ASCII spellings for symbols the embedded text face cannot draw.
 *
 * This is not belt-and-braces — it is load-bearing. The vendored faces do
 * not cover mathematical Unicode: Newsreader is missing **120 of the 135**
 * characters this module can emit, Inter 30, JetBrains Mono 48. A character
 * with no glyph renders as `.notdef`, which in these fonts is a drawn
 * hollow box, not a blank — so an uncovered substitution turns readable
 * notation into `□`. An earlier version of this file styled inline maths in
 * Newsreader and shipped `E[X_j \mid X_{-j}]` to the page as `E[X□ □ X□□]`.
 *
 * So every substitution is checked against the actual font at load
 * (`RENDERABLE` below); anything it cannot draw falls back to the spelling
 * here, and anything with no spelling makes the whole expression
 * `faithful: false` so it keeps its source instead of printing boxes.
 */
const ASCII_FALLBACK: Record<string, string> = {
  '≡': ' = ', '∼': '~', '∝': ' proportional to ', '≪': ' << ', '≫': ' >> ',
  '∓': '-/+', '∗': '*', '⋆': '*', '∈': ' in ', '∉': ' not in ',
  '⊂': ' subset of ', '⊆': ' subset of ', '⊃': ' superset of ',
  '⊇': ' superset of ', '∪': ' union ', '∩': ' intersect ',
  '∀': 'for all ', '∃': 'there exists ', '∧': ' and ', '∨': ' or ',
  '∖': ' \\ ', '↦': ' -> ', '∇': 'grad ', '⋯': '...', '∣': '|',
  '∥': '||', '∠': 'angle ', '⊥': ' perpendicular to ',
  '∴': 'therefore ', '∵': 'because ', '∅': '{}',
};

import { pdfLog } from '@lib/loggers';
import { FONT_FILES } from './engine';

/** `\command` → the character it denotes. */
const COMMANDS: Record<string, string> = {
  // relations
  le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', sim: '∼', propto: '∝', ll: '≪', gg: '≫',
  // operators
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
  // sets and logic
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃',
  supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀',
  exists: '∃', neg: '¬', land: '∧', lor: '∨', setminus: '∖',
  // arrows
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒',
  Leftarrow: '⇐', leftrightarrow: '↔', mapsto: '↦',
  // misc
  infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫',
  ldots: '…', dots: '…', cdots: '⋯', mid: '∣', parallel: '∥',
  angle: '∠', perp: '⊥', therefore: '∴', because: '∵',
  // greek, lower
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  // greek, upper
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // spacing — all collapse to a single space
  quad: ' ', qquad: ' ', ',': ' ', ';': ' ', ':': ' ', '!': '',
  // function names keep their letters
  log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan',
  max: 'max', min: 'min', lim: 'lim', sup: 'sup', inf: 'inf',
  arg: 'arg', det: 'det', dim: 'dim', deg: 'deg', gcd: 'gcd',
  // wrappers whose braces we simply drop
  left: '', right: '', text: '', mathrm: '', mathbf: '', mathit: '',
  displaystyle: '', limits: '',
};

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
  '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽',
  ')': '⁾', n: 'ⁿ', i: 'ⁱ',
};

const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
  '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍',
  ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ',
  m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ',
  v: 'ᵥ', x: 'ₓ',
};

/**
 * Characters the inline-maths face can actually draw, decided by reading the
 * font rather than by assuming. Built once at module load.
 *
 * Inter is the face used for inline maths: it is the body font, so the
 * notation sits in the line rather than switching family mid-sentence, and
 * it has the widest coverage of the three vendored faces.
 */
const renderable = (() => {
  const cache = new Map<string, boolean>();
  let font: { hasGlyphForCodePoint(cp: number): boolean } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fontkit = require('fontkit') as {
      openSync(p: string): { hasGlyphForCodePoint(cp: number): boolean };
    };
    font = fontkit.openSync(FONT_FILES.Inter.normal);
  } catch (e) {
    // Loud, because the consequence is invisible: with no font to check
    // against, only ASCII passes `renderable`, the ASCII table covers 29 of
    // ~135 emittable characters, and essentially all inline maths silently
    // degrades to raw LaTeX. `fontkit` is a declared dependency precisely so
    // this branch stays unreachable.
    pdfLog.error(`inline-math:fontkit-unavailable — inline maths will degrade to source: ${e instanceof Error ? e.message : String(e)}`);
    font = null;
  }
  return (ch: string): boolean => {
    const hit = cache.get(ch);
    if (hit !== undefined) return hit;
    // ASCII is always safe; anything else must be in the font.
    const ok = ch.codePointAt(0)! < 128 || (font?.hasGlyphForCodePoint(ch.codePointAt(0)!) ?? false);
    cache.set(ch, ok);
    return ok;
  };
})();

/**
 * Replace a symbol with something the page can actually show.
 * Returns null when neither the glyph nor a spelling is available.
 */
const displayable = (symbol: string): string | null => {
  if (symbol === '' || [...symbol].every(renderable)) return symbol;
  const fallback = ASCII_FALLBACK[symbol];
  if (fallback !== undefined && [...fallback].every(renderable)) return fallback;
  return null;
};

/** Constructs with genuine two-dimensional layout. Unicode cannot do these. */
const UNREPRESENTABLE = /\\(frac|dfrac|tfrac|sqrt|binom|begin|matrix|pmatrix|bmatrix|over|atop|substack)\b/;

const mapScript = (body: string, table: Record<string, string>): string | null => {
  let out = '';
  for (const ch of body) {
    const mapped = table[ch];
    // No mapping, or a mapping the font cannot draw — leave the whole
    // script alone rather than emit a box.
    if (mapped === undefined || !renderable(mapped)) return null;
    out += mapped;
  }
  return out;
};

export interface InlineMath {
  text: string;
  /** False when the expression needs layout Unicode cannot express. */
  faithful: boolean;
}

/**
 * Convert one inline TeX expression to readable text.
 *
 * Returns `faithful: false` when the source contains a construct that
 * genuinely needs two dimensions, so the caller can render it as a display
 * block instead of printing something misleading.
 */
export const inlineMathToText = (tex: string): InlineMath => {
  if (UNREPRESENTABLE.test(tex)) return { text: tex.trim(), faithful: false };

  let s = tex;

  // `\command`. Whitespace after the command is deliberately NOT consumed:
  // `\cdot p` must stay `· p`, not `·p`. A trailing `\s*` here silently
  // welded operators to their right-hand operand.
  let unshowable = false;
  s = s.replace(/\\([a-zA-Z]+)/g, (_all, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, name)) {
      // An unknown command is NOT safely convertible: dropping the
      // backslash splices a bare English word into the prose
      // (`\hat{y}` → `hat y`, `\cfrac{1}{2}` → `cfrac 12`, which reads as
      // the integer twelve). Bail out and keep the source instead.
      unshowable = true;
      return _all;
    }
    const shown = displayable(COMMANDS[name]);
    if (shown === null) {
      unshowable = true;
      return _all;
    }
    return shown;
  });
  if (unshowable) return { text: tex.trim(), faithful: false };
  // Escaped punctuation. `\{ \} \_` are held behind sentinels: unescaping
  // them here would let the brace-stripping and subscript passes below eat
  // them — `P(x) \in \{0, 1\}` lost its set braces, and `x\_1` turned a
  // literal underscore into a subscript.
  const LBRACE = '\u0001';
  const RBRACE = '\u0002';
  const USCORE = '\u0003';
  s = s.replace(/\\([,;:!%&_{}$#])/g, (_all, ch: string) => {
    if (ch === '{') return LBRACE;
    if (ch === '}') return RBRACE;
    if (ch === '_') return USCORE;
    return Object.prototype.hasOwnProperty.call(COMMANDS, ch) ? COMMANDS[ch] : ch;
  });

  // ^{...} / _{...} and single-character ^x / _x.
  //
  // A BRACED group that cannot be mapped is fatal, not merely left alone:
  // the brace-strip below would delete the grouping and `e^{2x}` would read
  // as `e^2x`, i.e. e² · x — a different expression, printed with
  // `faithful: true`. So an unmappable braced group bails out to the source.
  let unmappableGroup = false;
  const bracedScript = (re: RegExp, table: Record<string, string>) => {
    s = s.replace(re, (all: string, body: string) => {
      const mapped = mapScript(body, table);
      if (mapped === null) unmappableGroup = true;
      return mapped ?? all;
    });
  };
  // A bare `^x` / `_x` that cannot be mapped is harmless — no grouping is
  // lost, the caret or underscore simply stays visible.
  const bareScript = (re: RegExp, table: Record<string, string>) => {
    s = s.replace(re, (all: string, body: string) => mapScript(body, table) ?? all);
  };
  bracedScript(/\^\{([^{}]*)\}/g, SUPERSCRIPT);
  bareScript(/\^(\S)/g, SUPERSCRIPT);
  bracedScript(/_\{([^{}]*)\}/g, SUBSCRIPT);
  bareScript(/_(\S)/g, SUBSCRIPT);
  if (unmappableGroup) return { text: tex.trim(), faithful: false };

  // `50{,}000` — TeX's trick for a thousands separator.
  s = s.replace(/\{([,.])\}/g, '$1');
  // Remaining grouping braces carry no meaning once scripts are resolved.
  s = s.replace(/[{}]/g, '');
  // Restore the literals that were held out of the brace/script passes.
  s = s.replace(/\u0001/g, '{').replace(/\u0002/g, '}').replace(/\u0003/g, '_');
  // Collapse the whitespace the command expansion introduced.
  s = s.replace(/\s+/g, ' ').trim();

  return { text: s, faithful: true };
};

/** Test-only surface: what the coverage assertions iterate over. */
export const SCRIPTS_FOR_TESTS: string[] = [
  ...new Set([...Object.values(SUPERSCRIPT), ...Object.values(SUBSCRIPT)]),
];
export const COMMANDS_FOR_TESTS: { name: string; symbol: string }[] = Object.entries(COMMANDS).map(
  ([name, symbol]) => ({ name, symbol }),
);
