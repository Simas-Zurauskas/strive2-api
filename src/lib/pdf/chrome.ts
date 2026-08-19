/**
 * The furniture around the content: wordmark, cover, back page, running
 * header and footer.
 *
 * The "Strive logo" is a WORDMARK, not an image file — the product sets the
 * word `Strive` in the heading serif, italic, 400
 * (`client/src/components/Navbar/Navbar.styles.ts:111-127`), and there is no
 * logo asset in `client/public/`. Reproducing it as type is therefore more
 * faithful than inventing a mark, and it stays crisp at any zoom.
 *
 * The brief was "minimal, but professionally styled and grounded", with a
 * body that is easy to read and styling that is not intrusive. So the
 * chrome is: a gold hairline, a small-caps eyebrow, the serif for display
 * type, and nothing else. The cover carries neither header nor footer; the
 * footer starts on page 2 and the header on page 3, so the contents page
 * does not get a redundant running title.
 */

import type { Content, DynamicContent } from 'pdfmake/interfaces';
import { COLORS, FONT_SIZE, PAGE } from './theme';

const SITE = 'strive-learning.com';

/** `Strive` in Newsreader italic — the product's own wordmark. */
export const wordmark = (fontSize: number): Content =>
  ({ text: 'Strive', font: 'Newsreader', italics: true, fontSize, color: COLORS.foreground }) as Content;

/** The short gold rule that sits under the wordmark on cover and back page. */
export const goldRule = (width: number, marginTop = 12, marginBottom = 22): Content =>
  ({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 2, lineColor: COLORS.gold }],
    margin: [0, marginTop, 0, marginBottom],
  }) as Content;

/** A hairline the width of the text column. */
export const hairline = (width: number): Content =>
  ({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.5, lineColor: COLORS.border }],
    margin: [0, 5, 0, 10],
  }) as Content;

export interface CoverOptions {
  /** `COURSE` or `MODULE 2 · LESSON 3` */
  eyebrow: string;
  title: string;
  /** e.g. `9 modules · 57 lessons`, or the course name on a lesson cover */
  subtitle?: string;
  /** e.g. `Generated for Ada Lovelace · 19 August 2026` */
  footnote?: string;
}

export const coverPage = ({ eyebrow, title, subtitle, footnote }: CoverOptions): Content[] => [
  { ...(wordmark(FONT_SIZE.wordmark) as object), margin: [0, 132, 0, 0] } as Content,
  goldRule(44),
  { text: eyebrow.toUpperCase(), style: 'eyebrow' } as Content,
  { text: title, style: 'coverTitle' } as Content,
  ...(subtitle ? [{ text: subtitle, style: 'coverSubtitle' } as Content] : []),
  ...(footnote ? [{ text: footnote, style: 'coverFootnote' } as Content] : []),
];

/**
 * The closing page. It exists to say plainly what the PDF does NOT contain,
 * so nobody reads a shortened lesson and assumes that is all there was.
 */
export const backPage = (): Content[] => [
  { ...(wordmark(22) as object), pageBreak: 'before', margin: [0, 158, 0, 0] } as Content,
  goldRule(36, 10, 18),
  {
    text: 'This course was generated for one learner — you.',
    font: 'Newsreader',
    italics: true,
    fontSize: 13,
    color: COLORS.foreground,
    margin: [0, 0, 0, 10],
  } as Content,
  {
    text: 'Quizzes, interactive exercises and spaced-review cards live in the app and are not reproduced here.',
    style: 'body',
    color: COLORS.muted,
  } as Content,
  { text: SITE, style: 'backLink', link: `https://${SITE}` } as Content,
];

/**
 * Running header — wordmark left, document title right. Suppressed on the
 * cover and on the page after it, so a two-page front matter stays clean.
 */
export const makeHeader = (documentTitle: string): DynamicContent =>
  (currentPage: number) =>
    currentPage <= 2
      ? undefined
      : ({
          columns: [
            { text: 'Strive', font: 'Newsreader', italics: true, fontSize: 9, color: COLORS.muted },
            {
              text: documentTitle,
              fontSize: FONT_SIZE.tiny,
              color: COLORS.muted,
              alignment: 'right',
              margin: [0, 1.5, 0, 0],
            },
          ],
          margin: [PAGE.margins[0], 18, PAGE.margins[2], 0],
        } as Content);

/** Running footer — domain left, `n of N` right. Suppressed on the cover. */
export const makeFooter = (): DynamicContent =>
  (currentPage: number, pageCount: number) =>
    currentPage === 1
      ? undefined
      : ({
          columns: [
            { text: SITE, fontSize: FONT_SIZE.tiny, color: COLORS.muted },
            {
              text: `${currentPage} of ${pageCount}`,
              fontSize: FONT_SIZE.tiny,
              color: COLORS.muted,
              alignment: 'right',
            },
          ],
          margin: [PAGE.margins[0], 20, PAGE.margins[2], 0],
        } as Content);

export const CHROME_STYLES = {
  eyebrow: {
    fontSize: FONT_SIZE.tiny,
    characterSpacing: 2.4,
    color: COLORS.goldText,
    margin: [0, 0, 0, 8],
  },
  coverTitle: {
    font: 'Newsreader',
    fontSize: FONT_SIZE.coverTitle,
    lineHeight: 1.18,
    color: COLORS.foreground,
  },
  coverSubtitle: { fontSize: FONT_SIZE.body, color: COLORS.muted, margin: [0, 15, 0, 0] },
  coverFootnote: { fontSize: FONT_SIZE.small, color: COLORS.muted, margin: [0, 4, 0, 0] },
  backLink: { fontSize: FONT_SIZE.body, color: COLORS.goldText, margin: [0, 16, 0, 0] },
} as const;
