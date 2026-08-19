/**
 * Phase 5 — the block inclusion policy.
 *
 * The quiz exclusion is the single most requirement-load-bearing behaviour
 * in this task, so it is asserted twice: once against the real shape (all
 * the text lives in `metadata`) and once against a synthetic block that has
 * non-empty `content`. Only the second can go red when the exclusion is
 * removed — real quiz blocks have an EMPTY content field, so a
 * content-driven renderer emits nothing and a metadata-only assertion stays
 * green whether or not the exclusion works.
 */

import { describe, test, expect } from 'vitest';
import { blocksToContent, EXCLUDED_BLOCK_TYPES } from './blocks';
import {
  CALLOUT_TEXT,
  EXERCISE_EXPECTED_OUTPUT,
  EXERCISE_PROSE,
  EXERCISE_STARTER_CODE,
  INTRO_TEXT,
  LESSON_BLOCKS,
  LINK_TITLE,
  QUIZ_EXPLANATION,
  QUIZ_OPTIONS,
  QUIZ_QUESTION,
  SECTION_HEADING,
  SUMMARY_BULLET,
  SYNTHETIC_QUIZ_CONTENT_MARKER,
  UNSUPPORTED_DIAGRAM_BLOCK,
} from './__fixtures__/lesson';

const serialise = async (blocks = LESSON_BLOCKS) =>
  JSON.stringify((await blocksToContent(blocks)).content);

describe('included content', () => {
  test.each([
    ['intro', INTRO_TEXT],
    ['section heading', SECTION_HEADING],
    ['callout', CALLOUT_TEXT],
    ['summary', SUMMARY_BULLET],
    ['links', LINK_TITLE],
  ])('%s reaches the page', async (_name, needle) => {
    expect(await serialise()).toContain(needle);
  });

  test('a code block is rendered', async () => {
    expect(await serialise()).toContain('SimpleImputer');
  });
});

describe('quizzes are excluded', () => {
  test('no quiz question, option or explanation appears', async () => {
    const s = await serialise();
    expect(s).not.toContain(QUIZ_QUESTION);
    expect(s).not.toContain(QUIZ_EXPLANATION);
    for (const option of QUIZ_OPTIONS) expect(s).not.toContain(option);
  });

  // THE falsifiable one. Real quiz blocks have empty `content`, so the
  // assertion above passes even with the exclusion removed.
  test('a quiz block’s own content is suppressed', async () => {
    expect(await serialise()).not.toContain(SYNTHETIC_QUIZ_CONTENT_MARKER);
  });

  test('quiz is in the exclusion set', () => {
    expect(EXCLUDED_BLOCK_TYPES.has('quiz')).toBe(true);
  });
});

describe('exercises keep their prose and lose their code', () => {
  test('the prose is rendered', async () => {
    expect(await serialise()).toContain(EXERCISE_PROSE);
  });

  test('starter code and expected output never appear', async () => {
    const s = await serialise();
    expect(s).not.toContain(EXERCISE_STARTER_CODE);
    expect(s).not.toContain('starterCodeMustNotAppear');
    expect(s).not.toContain(EXERCISE_EXPECTED_OUTPUT);
  });
});

describe('ordering', () => {
  test('fractional order values land in numeric position', async () => {
    const s = await serialise();
    // The exercise (order 12.5) must come after the diagram (order 8) and
    // before the summary (order 13). A lexicographic sort would put 12.5
    // before 8.
    const diagramAt = s.indexOf('svg');
    const exerciseAt = s.indexOf(EXERCISE_PROSE);
    const summaryAt = s.indexOf(SUMMARY_BULLET);
    expect(diagramAt).toBeGreaterThan(-1);
    expect(diagramAt).toBeLessThan(exerciseAt);
    expect(exerciseAt).toBeLessThan(summaryAt);
  });
});

describe('diagrams', () => {
  test('a renderable diagram becomes an svg node and is counted', async () => {
    const r = await blocksToContent(LESSON_BLOCKS);
    expect(r.diagrams).toBe(1);
    expect(r.diagramFallbacks).toBe(0);
    expect(JSON.stringify(r.content)).toContain('svg');
  });

  test('an unrenderable diagram leaves exactly one fallback line, not a hole', async () => {
    const r = await blocksToContent([UNSUPPORTED_DIAGRAM_BLOCK]);
    expect(r.diagrams).toBe(0);
    expect(r.diagramFallbacks).toBe(1);
    expect(r.content).toHaveLength(1);
    expect(JSON.stringify(r.content)).toContain('view this lesson in Strive');
  });
});

describe('edges', () => {
  test('an empty block list resolves to empty content, not a throw', async () => {
    await expect(blocksToContent([])).resolves.toMatchObject({ content: [], diagrams: 0 });
  });

  test('a lesson of nothing but quizzes yields no content', async () => {
    const onlyQuizzes = LESSON_BLOCKS.filter((b) => b.type === 'quiz');
    expect(onlyQuizzes.length).toBeGreaterThan(0);
    const r = await blocksToContent(onlyQuizzes);
    expect(r.content).toEqual([]);
  });
});
