import katex from 'katex';

export interface LatexSanitizeResult {
  text: string;
  failedSpans: number;
}

/**
 * Match $$ ... $$ display math (non-greedy, may span newlines).
 * Runs before the inline pass so `$$…$$` is never misread as two inline `$…$`.
 */
const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/g;

/**
 * Match $ ... $ inline math, mimicking remark-math delimiter rules:
 *  - opening `$` must not be preceded by an alphanumeric or `\` (so `$5` in prose doesn't match)
 *  - opening `$` must not be immediately followed by whitespace
 *  - closing `$` must not be immediately preceded by whitespace
 *  - closing `$` must not be followed by an alphanumeric
 *  - inner content cannot contain `$` or newlines
 */
const INLINE_MATH_RE = /(?<![\\a-zA-Z0-9])\$(?!\s)([^\n$]+?)(?<!\s)\$(?![a-zA-Z0-9])/g;

/**
 * Validate every LaTeX span in `text` by attempting a server-side KaTeX render.
 * Spans that fail to parse are replaced with inline-code fallbacks (e.g. `` `x^2` ``),
 * so malformed LaTeX from the LLM never crashes the client renderer.
 */
export function sanitizeLatex(text: string): LatexSanitizeResult {
  if (!text || (!text.includes('$'))) {
    return { text, failedSpans: 0 };
  }

  let failedSpans = 0;

  const withValidatedDisplay = text.replace(DISPLAY_MATH_RE, (match, latex: string) => {
    try {
      katex.renderToString(latex, { throwOnError: true, strict: 'ignore', displayMode: true });
      return match;
    } catch {
      failedSpans++;
      return `\`${latex.trim()}\``;
    }
  });

  const withValidatedInline = withValidatedDisplay.replace(INLINE_MATH_RE, (match, latex: string) => {
    try {
      katex.renderToString(latex, { throwOnError: true, strict: 'ignore', displayMode: false });
      return match;
    } catch {
      failedSpans++;
      return `\`${latex.trim()}\``;
    }
  });

  return { text: withValidatedInline, failedSpans };
}
