/**
 * Phase 7 — the lesson and course document builders.
 *
 * The TOC assertions matter most: "a table of contents linked to pages when
 * clicked" is the one part of the requirement that is invisible in a
 * screenshot. `/GoTo` actions and named destinations in the rendered PDF
 * are the only real evidence, so this file renders for real and reads the
 * bytes back.
 */

import { describe, test, expect } from 'vitest';
import sharp from 'sharp';
import { buildCourseDocument, buildLessonDocument, type LessonForPdf } from './documents';
import { renderPdf } from './engine';
import { LESSON_BLOCKS } from './__fixtures__/lesson';

const jpegDataUri = async (): Promise<string> => {
  const buf = await sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 44, g: 85, b: 69 } },
  })
    .jpeg()
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
};

const lesson = (over: Partial<LessonForPdf> = {}): LessonForPdf => ({
  moduleIndex: 0,
  lessonIndex: 0,
  moduleName: 'Foundations',
  lessonName: 'Handling Missing Data',
  blocks: LESSON_BLOCKS,
  heroDataUri: null,
  completed: true,
  ...over,
});

const COMMON = { generatedFor: 'Ada Lovelace', generatedOn: '19 August 2026' };

const MODULES = [
  {
    name: 'Foundations',
    lessons: [
      { name: 'Handling Missing Data', moduleIndex: 0, lessonIndex: 0 },
      { name: 'Feature Scaling', moduleIndex: 0, lessonIndex: 1 },
    ],
  },
  {
    name: 'Modelling',
    lessons: [{ name: 'Linear Models', moduleIndex: 1, lessonIndex: 0 }],
  },
];

const json = (v: unknown) => JSON.stringify(v);

describe('lesson document', () => {
  test('opens with the wordmark and closes with the back page', async () => {
    const { doc } = await buildLessonDocument({ lesson: lesson(), courseName: 'ML', ...COMMON });
    const content = doc.content as { text?: string }[];
    expect(content[0].text).toBe('Strive');
    expect(json(content.at(-1))).toContain('strive-learning.com');
  });

  test('renders to a real PDF', async () => {
    const { doc } = await buildLessonDocument({ lesson: lesson(), courseName: 'ML', ...COMMON });
    const buf = await renderPdf(doc);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('a hero image reaches the page as an image node', async () => {
    const { doc } = await buildLessonDocument({
      lesson: lesson({ heroDataUri: await jpegDataUri() }),
      courseName: 'ML',
      ...COMMON,
    });
    expect(json(doc.content)).toContain('"image"');
  });

  test('no quiz text survives into the document', async () => {
    const { doc } = await buildLessonDocument({ lesson: lesson(), courseName: 'ML', ...COMMON });
    expect(json(doc.content)).not.toContain('Why will the imputed values');
  });
});

// Node-tree assertions cannot see content that pdfmake drops at layout
// time. Inline maths was emitted as an `{svg}` inside a `text` array —
// present in the tree, absent from every rendered page, no error anywhere.
// These render for real and read the bytes.
describe('content actually reaches the page, not just the node tree', () => {
  const textBlocks = (content: string) => [
    { id: 'a', type: 'section' as const, order: 0, content, metadata: null },
  ];

  const renderSection = async (content: string) => {
    const { doc } = await buildLessonDocument({
      lesson: lesson({ blocks: textBlocks(content) }),
      courseName: 'ML',
      ...COMMON,
    });
    return renderPdf(doc);
  };

  test('a paragraph with inline maths is materially larger than the same paragraph without', async () => {
    const withMath = await renderSection('The neighbour count $k = 5$ controls the bias.');
    const without = await renderSection('The neighbour count controls the bias.');
    // The expression has to cost real bytes. When it was silently dropped
    // the two differed by twelve.
    expect(withMath.length - without.length).toBeGreaterThan(80);
  });

  test('display maths emits vector drawing operators', async () => {
    const withMath = await renderSection('Because:\n\n$$P(M) = 1$$\n\nwe conclude.');
    const without = await renderSection('Because:\n\nwe conclude.');
    expect(withMath.length - without.length).toBeGreaterThan(500);
  });

  test('a table reaches the page', async () => {
    const withTable = await renderSection('Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    const without = await renderSection('Intro.');
    expect(withTable.length).toBeGreaterThan(without.length);
  });
});

describe('course document — table of contents', () => {
  const threeLessons = [
    lesson({ moduleIndex: 0, lessonIndex: 0, lessonName: 'Handling Missing Data' }),
    lesson({ moduleIndex: 0, lessonIndex: 1, lessonName: 'Feature Scaling' }),
    lesson({ moduleIndex: 1, lessonIndex: 0, lessonName: 'Linear Models', moduleName: 'Modelling' }),
  ];

  test('every completed lesson carries tocItem and a unique id', async () => {
    const { doc } = await buildCourseDocument({
      courseName: 'ML',
      modules: MODULES,
      lessons: threeLessons,
      ...COMMON,
    });
    const nodes = doc.content as { tocItem?: string; id?: string }[];
    // The contents has two levels, so filter to the lesson entries — module
    // headings are asserted separately below.
    const lessonToc = nodes.filter((n) => n.tocItem === 'main' && n.id?.startsWith('lesson-'));
    expect(lessonToc).toHaveLength(3);
    expect(new Set(lessonToc.map((n) => n.id)).size).toBe(3);
  });

  test('exactly one toc node exists', async () => {
    const { doc } = await buildCourseDocument({
      courseName: 'ML',
      modules: MODULES,
      lessons: threeLessons,
      ...COMMON,
    });
    const tocs = (doc.content as object[]).filter((n) => 'toc' in n);
    expect(tocs).toHaveLength(1);
  });

  test('the contents has two levels — each module heading, then its lessons', async () => {
    const { doc } = await buildCourseDocument({
      courseName: 'ML',
      modules: MODULES,
      lessons: threeLessons,
      ...COMMON,
    });
    const toc = (doc.content as { tocItem?: string; text?: string; id?: string }[]).filter(
      (n) => n.tocItem === 'main',
    );
    // 2 modules + 3 lessons, in reading order, module heading first.
    expect(toc.map((n) => n.text)).toEqual([
      'Foundations',
      'Handling Missing Data',
      'Feature Scaling',
      'Modelling',
      'Linear Models',
    ]);
    expect(toc.filter((n) => n.id?.startsWith('module-'))).toHaveLength(2);
  });

  test('a module heading is emitted once, not once per lesson', async () => {
    const { doc } = await buildCourseDocument({
      courseName: 'ML',
      modules: MODULES,
      lessons: threeLessons,
      ...COMMON,
    });
    const headings = (doc.content as { style?: string; text?: string }[]).filter(
      (n) => n.style === 'moduleTitle',
    );
    expect(headings.map((h) => h.text)).toEqual(['Foundations', 'Modelling']);
  });

  test('each lesson starts on a new page', async () => {
    const { doc } = await buildCourseDocument({
      courseName: 'ML',
      modules: MODULES,
      lessons: threeLessons,
      ...COMMON,
    });
    // A lesson opening a module is broken by the module heading; the rest
    // break on their own eyebrow. Either way every lesson starts a page,
    // and no page is broken twice.
    const nodes = doc.content as { pageBreak?: string; style?: string }[];
    const moduleBreaks = nodes.filter((n) => n.pageBreak === 'before' && n.style === 'moduleTitle');
    const lessonBreaks = nodes.filter((n) => n.pageBreak === 'before' && n.style === 'eyebrow');
    expect(moduleBreaks).toHaveLength(2);
    expect(lessonBreaks).toHaveLength(1); // only Feature Scaling, mid-module
    expect(moduleBreaks.length + lessonBreaks.length).toBe(3);
  });

  // The requirement's "linked to pages when clicked". Styled text that
  // looks like a contents list would satisfy every assertion above.
  test('the rendered PDF contains one GoTo action per lesson and every destination', async () => {
    const { doc } = await buildCourseDocument({
      courseName: 'ML',
      modules: MODULES,
      lessons: threeLessons,
      ...COMMON,
    });
    const bytes = (await renderPdf(doc)).toString('latin1');

    const gotoCount = (bytes.match(/\/GoTo/g) ?? []).length;
    expect(gotoCount).toBeGreaterThanOrEqual(3);

    for (const l of threeLessons) {
      expect(bytes).toContain(`lesson-${l.moduleIndex}-${l.lessonIndex}`);
    }
  });

  test('a hero sits directly under the lesson title, before any prose', async () => {
    const uri = await jpegDataUri();
    const { doc } = await buildCourseDocument({
      courseName: 'ML',
      modules: MODULES,
      lessons: [{ ...threeLessons[0], heroDataUri: uri }],
      ...COMMON,
    });
    const nodes = doc.content as unknown as Record<string, unknown>[];
    const titleAt = nodes.findIndex((n) => n.style === 'lessonTitle');
    const heroAt = nodes.findIndex((n) => 'image' in n);
    const firstProseAt = nodes.findIndex((n, i) => i > titleAt && n.style === 'lead');
    expect(titleAt).toBeGreaterThan(-1);
    expect(heroAt).toBeGreaterThan(titleAt);
    expect(heroAt).toBeLessThan(firstProseAt);
  });

  test('hero images appear in the COURSE document too, not just the lesson one', async () => {
    const uri = await jpegDataUri();
    const { doc } = await buildCourseDocument({
      courseName: 'ML',
      modules: MODULES,
      lessons: threeLessons.map((l) => ({ ...l, heroDataUri: uri })),
      ...COMMON,
    });
    const bytes = (await renderPdf(doc)).toString('latin1');
    const images = (bytes.match(/\/Subtype\s*\/Image/g) ?? []).length;
    expect(images).toBeGreaterThanOrEqual(3);
    expect(bytes).toContain('DCTDecode'); // JPEG, embedded as-is
  });
});

describe('course document — incomplete and empty states', () => {
  test('a lesson that is not completed is excluded from the body', async () => {
    const { doc, stats } = await buildCourseDocument({
      courseName: 'ML',
      modules: MODULES,
      lessons: [
        lesson({ moduleIndex: 0, lessonIndex: 0, lessonName: 'Done Lesson', completed: true }),
        lesson({ moduleIndex: 0, lessonIndex: 1, lessonName: 'Streaming Lesson', completed: false }),
      ],
      ...COMMON,
    });
    const s = json(doc.content);
    expect(stats.lessons).toBe(1);
    expect(s).toContain('Done Lesson');
    // Its title may appear in the "not included" list, but never as a
    // tocItem — i.e. never as a chapter of the document.
    const lessonTocTitles = (doc.content as { tocItem?: string; text?: string; id?: string }[])
      .filter((n) => n.tocItem === 'main' && n.id?.startsWith('lesson-'))
      .map((n) => n.text);
    expect(lessonTocTitles).toEqual(['Done Lesson']);
  });

  // The reason belongs to the section, not to every row. This fixture leaves
  // TWO lessons ungenerated, in two different modules, which is what makes the
  // count assertion able to fail: the earlier per-row phrasing produced one
  // occurrence per missing lesson.
  test('ungenerated lessons are listed, with the reason stated exactly once', async () => {
    const { doc } = await buildCourseDocument({
      courseName: 'ML',
      modules: MODULES,
      lessons: [lesson({ moduleIndex: 0, lessonIndex: 0 })],
      ...COMMON,
    });
    const s = json(doc.content);
    expect(s.match(/have not been generated yet/g)).toHaveLength(1);
    expect(s).not.toContain('not yet generated');
    expect(s).toContain('Feature Scaling');
    expect(s).toContain('Linear Models');
  });

  test('a course with zero completed lessons still renders, with an explicit empty state', async () => {
    const { doc, stats } = await buildCourseDocument({
      courseName: 'Empty Course',
      modules: MODULES,
      lessons: [],
      ...COMMON,
    });
    expect(stats.lessons).toBe(0);
    expect(json(doc.content)).toContain('No lessons have been generated');
    const buf = await renderPdf(doc);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('header and footer', () => {
  test('the cover has neither; the footer starts on page 2 and the header on page 3', async () => {
    const { doc } = await buildLessonDocument({ lesson: lesson(), courseName: 'ML', ...COMMON });
    const header = doc.header as (p: number, c: number) => unknown;
    const footer = doc.footer as (p: number, c: number) => unknown;

    expect(header(1, 9)).toBeUndefined();
    expect(header(2, 9)).toBeUndefined();
    expect(header(3, 9)).toBeDefined();

    expect(footer(1, 9)).toBeUndefined();
    expect(footer(2, 9)).toBeDefined();
  });

  test('the footer shows the page number and total', async () => {
    const { doc } = await buildLessonDocument({ lesson: lesson(), courseName: 'ML', ...COMMON });
    const footer = doc.footer as (p: number, c: number) => unknown;
    expect(json(footer(4, 12))).toContain('4 of 12');
  });
});
