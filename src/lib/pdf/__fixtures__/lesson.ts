/**
 * A lesson fixture built from a real production lesson's block shapes.
 *
 * ONE block here is synthetic and deliberately so: `SYNTHETIC_QUIZ_WITH_CONTENT`.
 * Real quiz blocks carry an EMPTY `content` — the generator is told "The
 * content field should be empty string for quiz blocks (all data is in
 * metadata)" (`lib/ai/agents/lessonGeneration/prompts.ts:371`). That makes
 * the quiz exclusion unfalsifiable against real data: remove `quiz` from the
 * exclusion set and a content-driven renderer emits an empty string, so an
 * assertion looking for the question text still passes.
 *
 * The synthetic block gives the exclusion something it must actually
 * suppress, so the break-it step can turn a test red.
 */

import type { ILessonBlock } from '@models/LessonContentModel';

const b = (block: Partial<ILessonBlock> & Pick<ILessonBlock, 'id' | 'type' | 'order'>): ILessonBlock => ({
  content: '',
  metadata: null,
  ...block,
});

export const QUIZ_QUESTION = 'Why will the imputed values still be biased?';
export const QUIZ_OPTIONS = [
  'MICE assumes a multivariate Gaussian joint distribution',
  'MICE uses nan-Euclidean distance to find neighbors',
  'MICE requires more than 10 iterations to converge',
  'MICE trains its regression on observed rows only',
];
export const QUIZ_EXPLANATION = 'This is an MNAR scenario: the missing value itself drives the missingness.';

/** The distinctive string that must never reach the page. */
// No underscores: markdown treats `_x_` as emphasis, which splits the string
// into separate runs and makes a contiguous-substring assertion useless.
export const SYNTHETIC_QUIZ_CONTENT_MARKER = 'Quiz block prose that must never be rendered';

export const EXERCISE_PROSE = 'Compare three imputation strategies on a realistic MAR dataset.';
export const EXERCISE_STARTER_CODE = 'import numpy as np\nstarterCodeMustNotAppear = 1';
export const EXERCISE_EXPECTED_OUTPUT = 'expectedOutputMustNotAppear';

export const INTRO_TEXT = 'Real data is never complete, and missing values carry statistical signal.';
export const SECTION_HEADING = 'The Three Missing-Data Mechanisms';
export const CALLOUT_TEXT = 'Watch for survey data and self-reported fields.';
export const SUMMARY_BULLET = 'Missing data follows one of three mechanisms.';
export const LINK_TITLE = "Little's Test of Missing Completely at Random";

/**
 * Ordering note: `order` is FRACTIONAL in real rows — quizzes and exercises
 * are interleaved after the prose is generated. Sorting must be numeric.
 */
export const LESSON_BLOCKS: ILessonBlock[] = [
  b({ id: 'i1', type: 'intro', order: 0, content: INTRO_TEXT }),
  b({ id: 's1', type: 'section', order: 1, content: `## ${SECTION_HEADING}\n\nRubin (1976) formalized three mechanisms.` }),
  b({ id: 'c1', type: 'callout', order: 2, content: CALLOUT_TEXT, metadata: { variant: 'warning' } }),
  b({ id: 'code1', type: 'code', order: 3, content: 'imputer = SimpleImputer(strategy="mean")', metadata: { language: 'python' } }),
  b({ id: 'q1', type: 'quiz', order: 7.5, content: '', metadata: { question: QUIZ_QUESTION, options: QUIZ_OPTIONS, correctIndex: 3, explanation: QUIZ_EXPLANATION } }),
  b({ id: 'm1', type: 'mermaid', order: 8, content: 'flowchart TD\n  A["Observe"] --> B["Diagnose"]', metadata: { diagramType: 'flowchart' } }),
  b({ id: 'q2', type: 'quiz', order: 11.5, content: SYNTHETIC_QUIZ_CONTENT_MARKER, metadata: { question: 'Second question?', options: ['a', 'b'], correctIndex: 0 } }),
  b({ id: 'ex1', type: 'exercise', order: 12.5, content: EXERCISE_PROSE, metadata: { language: 'python', starterCode: EXERCISE_STARTER_CODE, expectedOutput: EXERCISE_EXPECTED_OUTPUT } }),
  b({ id: 'sum1', type: 'summary', order: 13, content: `- ${SUMMARY_BULLET}` }),
  b({ id: 'l1', type: 'links', order: 14, content: '', metadata: { links: [{ url: 'https://example.com/a', title: LINK_TITLE, description: 'Introduces the formal test.' }] } }),
];

/** A mermaid block whose source cannot be rendered — must degrade, not hole. */
export const UNSUPPORTED_DIAGRAM_BLOCK: ILessonBlock = b({
  id: 'm-bad',
  type: 'mermaid',
  order: 20,
  content: 'flowchart TD\n  this is not really a diagram',
  metadata: { diagramType: 'flowchart' },
});
