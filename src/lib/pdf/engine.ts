/**
 * The pdfmake engine: brand fonts in, sandbox on, `Buffer` out.
 *
 * Everything that talks to pdfmake goes through here, for two reasons.
 *
 * FONTS. The brand faces are vendored as static TTFs under `api/fonts/`,
 * not pulled at runtime. `@fontsource` ships woff2 only, which pdfkit
 * cannot read, and Google's `fonts/` repo now ships variable-only TTFs,
 * which pdfkit renders at a single default instance — bold and italic
 * would silently collapse into regular. The six files here are the static
 * per-weight instances from the Google Fonts CSS API.
 *
 * SANDBOX. pdfmake will dereference URLs and read local paths named inside
 * a document definition. The content this server feeds it is LLM-generated,
 * and the mermaid renderer's SVG literally arrives carrying
 * `@import url('https://fonts.googleapis.com/…')`. Left unrestricted that
 * is an SSRF and arbitrary-file-read surface reachable from generated
 * course content. Both policies are installed at module load, before any
 * document can be created, and `engine.test.ts` proves the enforcement by
 * driving `renderPdf` rather than by calling these lambdas.
 */

import path from 'node:path';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import pdfmake from 'pdfmake';

/**
 * `api/fonts/`, resolved from this module rather than from `process.cwd()`.
 *
 * The same relative hop works in both layouts, which is the point:
 *   dev   `api/src/lib/pdf/engine.ts`   -> up 3 -> `api/fonts`
 *   build `api/build/lib/pdf/engine.js` -> up 3 -> `<approot>/fonts`
 *
 * Same idiom as `@conf/versionInfo`, and `api/buildspec.yml` already ships
 * `fonts/**\/*` in the deploy artifact, so no build step had to change.
 */
export const FONT_DIR = path.resolve(__dirname, '..', '..', '..', 'fonts');

const font = (file: string): string => path.join(FONT_DIR, file);

/**
 * Exported so the test can assert every path exists — a typo here produces
 * a runtime failure on the first export, in production, which is exactly
 * the kind of thing that should fail in CI instead.
 *
 * `bolditalics` deliberately reuses the bold face in both families: neither
 * Inter nor Newsreader ships a bold-italic static instance we need, and the
 * combination does not occur in lesson content.
 */
export const FONT_FILES = {
  Inter: {
    normal: font('Inter-400.ttf'),
    bold: font('Inter-600.ttf'),
    italics: font('Inter-400Italic.ttf'),
    bolditalics: font('Inter-600.ttf'),
  },
  Newsreader: {
    normal: font('Newsreader-400.ttf'),
    bold: font('Newsreader-600.ttf'),
    italics: font('Newsreader-400Italic.ttf'),
    bolditalics: font('Newsreader-600.ttf'),
  },
  // Code is set monospaced because the alternative is wrong, not because it
  // is prettier: lesson code blocks are indentation-significant (Python is
  // the commonest language in them), and a proportional face destroys the
  // column alignment that carries the meaning. JetBrains Mono ships no
  // italic instance we need, so both italic slots reuse their upright twin.
  JetBrainsMono: {
    normal: font('JetBrainsMono-400.ttf'),
    bold: font('JetBrainsMono-600.ttf'),
    italics: font('JetBrainsMono-400.ttf'),
    bolditalics: font('JetBrainsMono-600.ttf'),
  },
} as const;

pdfmake.addFonts(FONT_FILES);

/**
 * Deny every outbound dereference. Nothing in a Strive PDF is fetched over
 * the network: diagrams and maths arrive as inline SVG, hero images as
 * in-memory buffers.
 */
pdfmake.setUrlAccessPolicy(() => false);

/**
 * Permit only the vendored font directory. `path.resolve` first so
 * `fonts/../../etc/passwd` cannot walk out, and the separator is appended
 * so a sibling directory named `fonts-evil` does not match the prefix.
 */
pdfmake.setLocalAccessPolicy((requested: string) => {
  const resolved = path.resolve(requested);
  return resolved === FONT_DIR || resolved.startsWith(FONT_DIR + path.sep);
});

export type PdfDocument = TDocumentDefinitions;

/** Render a document definition to a complete PDF in memory.
 *
 * Buffered, never streamed: a failure part-way through a 26-lesson course
 * must surface as a clean JSON 500, not as a half-written file the browser
 * has already started saving.
 */
export const renderPdf = async (doc: PdfDocument): Promise<Buffer> =>
  pdfmake.createPdf(doc).getBuffer();
