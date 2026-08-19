/**
 * The PDF's visual vocabulary — a deliberately small mirror of the app's
 * light theme (`client/src/theme/theme.ts`), pinned here rather than shared
 * because the two repos have no build-time coupling.
 *
 * PDFs are always rendered in the LIGHT palette. A dark-mode PDF would be a
 * cartridge-emptying trap for anyone who prints one, and paper has no
 * `prefers-color-scheme`.
 *
 * Sizes are in PDF points (1 pt = 1/72"). A4 is 595.28 x 841.89 pt.
 */

/** Light-theme colours, matching `client/src/theme/theme.ts` `themeColors.light`. */
export const COLORS = {
  /** page ground — `colorsLib.cream` */
  background: '#faf9f7',
  /** body copy — `colorsLib.gray900` */
  foreground: '#0f172a',
  /** secondary copy; ~4.9:1 on cream */
  muted: '#76706a',
  /** hairlines — `colorsLib.gray200` */
  border: '#dfd9d3',
  /** card ground */
  surface: '#ffffff',
  /** brand green — `colorsLib.primary` */
  accent: '#2c5545',
  /** brand gold — `colorsLib.secondary`; display sizes and rules only */
  gold: '#96793e',
  /** AA-safe gold for small text (~5.5:1 on cream) — theme's `tertiaryText` */
  goldText: '#7d6434',
  /** callout accents */
  warning: '#d97706',
  error: '#dc2626',
} as const;

/**
 * A4 page geometry.
 *
 * The side margins were trimmed 64 -> 54 pt and the vertical ones 72 -> 60 pt
 * on request, because the pages read as too airy; the top was then taken to
 * 48 pt (and the bottom to 54) to slim the running-header band toward the
 * proportions the web lesson header has. Note the trade-off that
 * buys: measured with fontkit against `fonts/Inter-400.ttf` at the 9.5 pt
 * body size, a 467 pt column already carries ~106 characters and the 487 pt
 * one carries ~111 — both past the 45-90 usually recommended for continuous
 * prose. (An earlier version of this comment claimed ~66; that was wrong.)
 * If the long lines ever become the complaint, the fix is to raise
 * `FONT_SIZE.body` rather than to push the margins back out.
 */
export const PAGE = {
  size: 'A4' as const,
  /** [left, top, right, bottom] */
  margins: [54, 48, 54, 54] as [number, number, number, number],
  width: 595.28,
  height: 841.89,
} as const;

/** Usable column width — everything scaled to fit is measured against this. */
export const CONTENT_WIDTH = PAGE.width - PAGE.margins[0] - PAGE.margins[2];

/**
 * Usable column height. Diagrams must be bounded on BOTH axes: an `LR` tree
 * trades width for height, and a width-only fit let a real 21-node diagram
 * end up 191 pt taller than the page.
 */
export const CONTENT_HEIGHT = PAGE.height - PAGE.margins[1] - PAGE.margins[3];

export const FONT_SIZE = {
  body: 9.5,
  small: 8.5,
  tiny: 7.5,
  h2: 13,
  lessonTitle: 20,
  contentsTitle: 21,
  coverTitle: 27,
  wordmark: 30,
} as const;

/** Line height for continuous prose. Trimmed from 1.55 with the margins. */
export const LINE_HEIGHT = 1.45;
