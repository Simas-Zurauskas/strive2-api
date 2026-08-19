/**
 * The two document builders.
 *
 * Both are pure of I/O — no Mongo, no S3, no HTTP. They take data that has
 * already been fetched (lesson rows, hero JPEG bytes) and return a pdfmake
 * document definition. They ARE async, because diagram and maths rendering
 * happen inside them and the mermaid renderer is reached through
 * `await import`; that is in-process CPU, not I/O.
 *
 * Keeping them I/O-free is what would let the whole render move onto
 * `jobRunner` later without a rewrite — the caller does the fetching, this
 * layer does the laying out.
 *
 * "Generated" means `completed === true`. During generation `jobRunner`
 * upserts partial rows every 500 ms WITHOUT setting `completed`
 * (`services/jobRunner.ts:416-430`); only the final write sets it
 * (`:579-595`). Selecting on row-existence would put a half-streamed lesson
 * — missing its later sections, summary and links — into a PDF with no
 * error at all.
 */

import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { ILessonBlock } from '@models/LessonContentModel';
import { BLOCK_STYLES, blocksToContent } from './blocks';
import { CHROME_STYLES, backPage, coverPage, hairline, makeFooter, makeHeader } from './chrome';
import { MARKDOWN_STYLES } from './markdown';
import { COLORS, CONTENT_WIDTH, FONT_SIZE, LINE_HEIGHT, PAGE } from './theme';

// The style objects are `as const`, so their readonly tuples do not line up
// with pdfmake's mutable `Margins`. The values are correct; only the
// variance differs, hence the double assertion.
const STYLES = { ...MARKDOWN_STYLES, ...BLOCK_STYLES, ...CHROME_STYLES } as unknown as TDocumentDefinitions['styles'];

const DEFAULT_STYLE = {
  font: 'Inter',
  fontSize: FONT_SIZE.body,
  color: COLORS.foreground,
  lineHeight: LINE_HEIGHT,
};

export interface LessonForPdf {
  moduleIndex: number;
  lessonIndex: number;
  moduleName: string;
  lessonName: string;
  blocks: ILessonBlock[];
  /** JPEG data URI, or null when the lesson has no hero or it failed to load. */
  heroDataUri: string | null;
  /** False for a lesson that exists but is still being generated. */
  completed: boolean;
}

export interface RenderStats {
  diagrams: number;
  diagramFallbacks: number;
  lessons: number;
}

const heroPlate = (dataUri: string | null): Content[] =>
  dataUri
    ? [{ image: dataUri, width: CONTENT_WIDTH, margin: [0, 4, 0, 12] } as Content]
    : [];

/** `Module 2 · Lesson 3` */
const lessonEyebrow = (l: LessonForPdf): string =>
  `Module ${l.moduleIndex + 1} · Lesson ${l.lessonIndex + 1}`;

const lessonId = (l: LessonForPdf): string => `lesson-${l.moduleIndex}-${l.lessonIndex}`;

// ── single lesson ──────────────────────────────────────────

export const buildLessonDocument = async ({
  lesson,
  courseName,
  generatedFor,
  generatedOn,
}: {
  lesson: LessonForPdf;
  courseName: string;
  generatedFor: string;
  generatedOn: string;
}): Promise<{ doc: TDocumentDefinitions; stats: RenderStats }> => {
  const { content: body, diagrams, diagramFallbacks } = await blocksToContent(lesson.blocks);

  const doc: TDocumentDefinitions = {
    pageSize: PAGE.size,
    pageMargins: PAGE.margins,
    info: { title: `${lesson.lessonName} — ${courseName}`, author: 'Strive' },
    header: makeHeader(lesson.lessonName),
    footer: makeFooter(),
    content: [
      ...coverPage({
        eyebrow: lessonEyebrow(lesson),
        title: lesson.lessonName,
        subtitle: courseName,
        footnote: `Generated for ${generatedFor} · ${generatedOn}`,
      }),
      { text: '', pageBreak: 'after' } as Content,
      ...heroPlate(lesson.heroDataUri),
      { text: lessonEyebrow(lesson).toUpperCase(), style: 'eyebrow' } as Content,
      { text: lesson.lessonName, style: 'lessonTitle' } as Content,
      hairline(CONTENT_WIDTH),
      ...body,
      ...backPage(),
    ],
    styles: { ...STYLES, lessonTitle: { font: 'Newsreader', fontSize: FONT_SIZE.lessonTitle, color: COLORS.foreground } },
    defaultStyle: DEFAULT_STYLE,
  };

  return { doc, stats: { diagrams, diagramFallbacks, lessons: 1 } };
};

// ── whole course ───────────────────────────────────────────

export interface CourseModuleForPdf {
  name: string;
  lessons: { name: string; moduleIndex: number; lessonIndex: number }[];
}

export const buildCourseDocument = async ({
  courseName,
  modules,
  lessons,
  generatedFor,
  generatedOn,
}: {
  courseName: string;
  /** The course structure, so ungenerated lessons can still be listed. */
  modules: CourseModuleForPdf[];
  /** Only lessons with content. Ones that are not `completed` are skipped. */
  lessons: LessonForPdf[];
  generatedFor: string;
  generatedOn: string;
}): Promise<{ doc: TDocumentDefinitions; stats: RenderStats }> => {
  const ready = lessons.filter((l) => l.completed);
  const readyKeys = new Set(ready.map((l) => `${l.moduleIndex}:${l.lessonIndex}`));

  let diagrams = 0;
  let diagramFallbacks = 0;
  const body: Content[] = [];

  // Grouped by module, so an 81-page export reads as a course rather than a
  // flat run of lessons. The module name is emitted once, on the first
  // lesson of that module, and carries its own `tocItem` so the contents
  // page has the same two levels the app's sidebar does.
  let lastModuleIndex: number | null = null;

  for (const lesson of ready) {
    const r = await blocksToContent(lesson.blocks);
    diagrams += r.diagrams;
    diagramFallbacks += r.diagramFallbacks;

    const startsModule = lesson.moduleIndex !== lastModuleIndex;
    lastModuleIndex = lesson.moduleIndex;

    if (startsModule) {
      body.push({
        text: modules[lesson.moduleIndex]?.name ?? lesson.moduleName,
        style: 'moduleTitle',
        tocItem: 'main',
        tocStyle: { bold: true, margin: [0, 8, 0, 2] },
        tocNumberStyle: { bold: true },
        id: `module-${lesson.moduleIndex}`,
        pageBreak: 'before',
      } as Content);
    }

    body.push(
      {
        text: lessonEyebrow(lesson).toUpperCase(),
        style: 'eyebrow',
        // The module heading already broke the page for the first lesson.
        ...(startsModule ? {} : { pageBreak: 'before' as const }),
      } as Content,
      // `tocItem` must sit on the node itself — a heading nested inside a
      // `stack` is not collected into the table of contents.
      {
        text: lesson.lessonName,
        style: 'lessonTitle',
        tocItem: 'main',
        tocStyle: { margin: [14, 0, 0, 0] },
        id: lessonId(lesson),
      } as Content,
      hairline(CONTENT_WIDTH),
      ...heroPlate(lesson.heroDataUri),
      ...r.content,
    );
  }

  // Lessons that exist in the structure but have no completed content are
  // listed so the reader can see the course is larger than the export.
  //
  // The reason is stated ONCE, under the heading. It used to be repeated as
  // `— not yet generated` on every row, which put the same four words after
  // every lesson name and made a short list read as a wall.
  const pending: Content[] = [];
  for (const mod of modules) {
    const missing = mod.lessons.filter((l) => !readyKeys.has(`${l.moduleIndex}:${l.lessonIndex}`));
    if (missing.length === 0) continue;
    pending.push({ text: mod.name, style: 'pendingModule' } as Content);
    pending.push({
      ul: missing.map((l) => l.name),
      style: 'pendingItem',
      margin: [0, 0, 0, 8],
    } as Content);
  }

  const lessonCount = modules.reduce((n, m) => n + m.lessons.length, 0);

  const doc: TDocumentDefinitions = {
    pageSize: PAGE.size,
    pageMargins: PAGE.margins,
    info: { title: courseName, author: 'Strive' },
    header: makeHeader(courseName),
    footer: makeFooter(),
    content: [
      ...coverPage({
        eyebrow: 'Course',
        title: courseName,
        subtitle: `${modules.length} ${modules.length === 1 ? 'module' : 'modules'} · ${lessonCount} ${lessonCount === 1 ? 'lesson' : 'lessons'}`,
        footnote: `Generated for ${generatedFor} · ${generatedOn}`,
      }),
      { text: '', pageBreak: 'after' } as Content,
      { text: 'Contents', style: 'contentsTitle' } as Content,
      {
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 44, y2: 0, lineWidth: 2, lineColor: COLORS.gold }],
        margin: [0, 9, 0, 13],
      } as Content,
      ready.length > 0
        ? ({
            toc: {
              id: 'main',
              textStyle: { fontSize: FONT_SIZE.body },
              numberStyle: { fontSize: FONT_SIZE.body, color: COLORS.muted },
            },
          } as Content)
        : ({
            text: 'No lessons have been generated in this course yet.',
            style: 'body',
            color: COLORS.muted,
          } as Content),
      ...(pending.length > 0
        ? [
            { text: 'Not included', style: 'pendingHeading' } as Content,
            {
              text: 'These lessons have not been generated yet, so they are not part of this export.',
              style: 'pendingNote',
            } as Content,
            ...pending,
          ]
        : []),
      ...body,
      ...backPage(),
    ],
    styles: {
      ...STYLES,
      lessonTitle: { font: 'Newsreader', fontSize: FONT_SIZE.lessonTitle, color: COLORS.foreground },
      // Sits at the top of the page it breaks to, like a chapter opener.
      // It used to carry a 200 pt top margin, which read as a designed
      // divider in isolation but is wrong here: the module heading shares a
      // page with the module's FIRST LESSON, so those 200 pt pushed the
      // lesson title, hairline and hero image most of the way down the sheet
      // and left a blank band under the running header.
      moduleTitle: {
        font: 'Newsreader',
        fontSize: FONT_SIZE.lessonTitle + 4,
        color: COLORS.foreground,
        margin: [0, 0, 0, 16],
      },
      contentsTitle: { font: 'Newsreader', fontSize: FONT_SIZE.contentsTitle, color: COLORS.foreground },
      pendingHeading: { fontSize: FONT_SIZE.small, color: COLORS.muted, margin: [0, 16, 0, 5], characterSpacing: 1 },
      pendingNote: { fontSize: FONT_SIZE.small, color: COLORS.muted, margin: [0, 0, 0, 8] },
      pendingModule: { fontSize: FONT_SIZE.small, bold: true, color: COLORS.muted, margin: [0, 6, 0, 2] },
      pendingItem: { fontSize: FONT_SIZE.small, color: COLORS.muted },
    },
    defaultStyle: DEFAULT_STYLE,
  };

  return { doc, stats: { diagrams, diagramFallbacks, lessons: ready.length } };
};
