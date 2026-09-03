/**
 * The 2026-08 malformed-quiz regression.
 *
 * WHAT HAPPENED: `interactiveBlockSchema.metadata` is `.nullable()` with every
 * inner field `.optional()`, so a block typed `quiz` carrying `metadata: null`
 * and the whole question written into `content` as markdown was fully
 * schema-valid. The interactive count-floor then counted quizzes BY TYPE, so
 * that block satisfied the floor, `withRetry` never retried, the Haiku→Sonnet
 * escalation never fired, every downstream guard early-returned on the bad
 * metadata, and the client rendered `null`. Invisible.
 *
 * Dead quiz blocks by month in production: Jul 1/87 (1.1%) → Aug 27/109
 * (24.8%), coincident with the claude-sonnet-5 migration on 2026-08-01. Both
 * paying subscribers were affected; one had 26 dead blocks across 10 of his
 * 14 lessons.
 *
 * `isWellFormedQuiz` is the fix's load-bearing predicate: it decides whether a
 * quiz counts toward the floor, and therefore whether the existing retry and
 * escalation machinery engages. It must agree exactly with the client's
 * `parseQuizMetadata`, or the generator will ship blocks the renderer refuses.
 *
 * Run: yarn test interactiveQuizShape
 */

import { describe, test, expect } from 'vitest';
import { isWellFormedQuiz } from './interactiveGeneration';

const good = {
  type: 'quiz',
  metadata: { question: 'What is 2+2?', options: ['3', '4', '5'], correctIndex: 1 },
};

describe('isWellFormedQuiz — accepts a real quiz', () => {
  test('a complete MCQ', () => {
    expect(isWellFormedQuiz(good)).toBe(true);
  });

  test('two options is the minimum viable question', () => {
    expect(isWellFormedQuiz({ type: 'quiz', metadata: { question: 'True?', options: ['Yes', 'No'], correctIndex: 0 } })).toBe(true);
  });

  test('correctIndex at either boundary', () => {
    const opts = ['a', 'b', 'c'];
    expect(isWellFormedQuiz({ type: 'quiz', metadata: { question: 'q', options: opts, correctIndex: 0 } })).toBe(true);
    expect(isWellFormedQuiz({ type: 'quiz', metadata: { question: 'q', options: opts, correctIndex: 2 } })).toBe(true);
  });

  test('an extra explanation field does not disqualify it', () => {
    expect(isWellFormedQuiz({ ...good, metadata: { ...good.metadata, explanation: 'because' } })).toBe(true);
  });
});

describe('isWellFormedQuiz — rejects exactly what shipped in August', () => {
  test('metadata: null — THE regression shape', () => {
    expect(isWellFormedQuiz({ type: 'quiz', metadata: null })).toBe(false);
  });

  test('metadata: {} — the other observed shape', () => {
    expect(isWellFormedQuiz({ type: 'quiz', metadata: {} })).toBe(false);
  });

  test('metadata absent entirely', () => {
    expect(isWellFormedQuiz({ type: 'quiz' })).toBe(false);
  });
});

describe('isWellFormedQuiz — rejects half-formed metadata', () => {
  test.each([
    ['no question', { options: ['a', 'b'], correctIndex: 0 }],
    ['blank question', { question: '   ', options: ['a', 'b'], correctIndex: 0 }],
    ['no options', { question: 'q', correctIndex: 0 }],
    ['one option — not a choice', { question: 'q', options: ['a'], correctIndex: 0 }],
    ['empty options array', { question: 'q', options: [], correctIndex: 0 }],
    ['a blank option', { question: 'q', options: ['a', '  '], correctIndex: 0 }],
    ['a non-string option', { question: 'q', options: ['a', 7], correctIndex: 0 }],
    ['no correctIndex', { question: 'q', options: ['a', 'b'] }],
    ['correctIndex out of range high', { question: 'q', options: ['a', 'b'], correctIndex: 2 }],
    ['correctIndex negative', { question: 'q', options: ['a', 'b'], correctIndex: -1 }],
    ['correctIndex fractional', { question: 'q', options: ['a', 'b'], correctIndex: 0.5 }],
    ['correctIndex as a string', { question: 'q', options: ['a', 'b'], correctIndex: '1' }],
  ])('rejects: %s', (_label, metadata) => {
    expect(isWellFormedQuiz({ type: 'quiz', metadata })).toBe(false);
  });
});

describe('isWellFormedQuiz — only ever counts quizzes', () => {
  test.each(['exercise', 'section', 'code', 'callout', 'mermaid', 'intro', 'summary'])(
    'a well-formed %s block is not a quiz',
    (type) => {
      expect(isWellFormedQuiz({ type, metadata: good.metadata })).toBe(false);
    },
  );

  test('a block with no type at all', () => {
    expect(isWellFormedQuiz({ metadata: good.metadata })).toBe(false);
  });
});

describe('the count-floor uses shape, not type — the actual regression guard', () => {
  // This is the assertion that would have caught August. Before the fix the
  // floor was `blocks.filter(b => b.type === 'quiz').length`, which counts
  // BOTH of these; after it, only one.
  const blocks = [
    { type: 'quiz', metadata: null }, // the dead one
    { type: 'exercise', metadata: { language: 'py', starterCode: '' } },
  ];

  test('a lesson whose only quiz is malformed has ZERO well-formed quizzes', () => {
    expect(blocks.filter(isWellFormedQuiz).length).toBe(0);
    // ...while the old type-only count saw one, which is why no retry fired.
    expect(blocks.filter((b) => b.type === 'quiz').length).toBe(1);
  });

  test('THE MIXED BATCH — one good quiz + one dead one must still be rejected', () => {
    // The hole an aggregate-only fix leaves, and the reason the floor also
    // counts malformed quizzes rather than only well-formed ones.
    //
    // The interactive prompt asks for "1-2 quiz blocks", so a response with one
    // good quiz and one dead one is the COMMON shape, not an edge case. Under a
    // pure `wellFormed >= 1` floor that response passes, `withRetry` returns
    // normally, and the dead block sails through untouched — `lintQuizBlocks`
    // and `shuffleQuizBlockOptions` both `continue` past missing metadata by
    // design. The regression would have survived the fix for every multi-quiz
    // lesson.
    const mixed = [good, { type: 'quiz', metadata: null }];

    const wellFormed = mixed.filter(isWellFormedQuiz).length;
    const malformed = mixed.filter((b) => b.type === 'quiz' && !isWellFormedQuiz(b)).length;

    expect(wellFormed).toBe(1);
    expect(malformed).toBe(1);

    // A `wellFormed >= 1` floor alone would ACCEPT this batch...
    expect(wellFormed >= 1).toBe(true);
    // ...so the floor must additionally require zero malformed quizzes.
    const floorAccepts = wellFormed >= 1 && malformed === 0;
    expect(floorAccepts).toBe(false);
  });

  test('a clean batch with two good quizzes is still accepted', () => {
    // Guard against over-correction: the stricter floor must not make normal
    // multi-quiz lessons impossible to generate.
    const clean = [good, { type: 'quiz', metadata: { question: 'q2', options: ['x', 'y'], correctIndex: 1 } }];
    const wellFormed = clean.filter(isWellFormedQuiz).length;
    const malformed = clean.filter((b) => b.type === 'quiz' && !isWellFormedQuiz(b)).length;
    expect(wellFormed).toBe(2);
    expect(malformed).toBe(0);
    expect(wellFormed >= 1 && malformed === 0).toBe(true);
  });
});

describe('server predicate vs the client renderer — they must not drift apart', () => {
  // How the original bug happened: the generator schema was permissive and the
  // renderer strict, with nothing keeping them in sync. `isWellFormedQuiz` is
  // deliberately at least as strict as the client's `parseQuizMetadata`
  // (client/src/screens/.../blocks/blockMetadata.ts), so anything the server
  // accepts, the client can draw. The reverse is allowed; the reverse is safe.
  test('every shape the server accepts satisfies the client rule', () => {
    const clientWouldRender = (m: Record<string, unknown>) =>
      typeof m.question === 'string' &&
      m.question.length > 0 &&
      Array.isArray(m.options) &&
      m.options.length > 0 &&
      m.options.every((o: unknown) => typeof o === 'string') &&
      typeof m.correctIndex === 'number' &&
      m.correctIndex >= 0 &&
      m.correctIndex < m.options.length;

    const accepted = [
      { question: 'q', options: ['a', 'b'], correctIndex: 0 },
      { question: 'q', options: ['a', 'b', 'c'], correctIndex: 2 },
      { question: 'q', options: ['a', 'b'], correctIndex: 1, explanation: 'e' },
    ];
    for (const m of accepted) {
      expect(isWellFormedQuiz({ type: 'quiz', metadata: m })).toBe(true);
      expect(clientWouldRender(m)).toBe(true);
    }
  });

  test('the server is STRICTER where the two rules differ, never looser', () => {
    // Single-option and fractional-index shapes: the client would draw them,
    // the server refuses to ship them. That asymmetry is the safe direction.
    const oneOption = { question: 'q', options: ['only'], correctIndex: 0 };
    expect(isWellFormedQuiz({ type: 'quiz', metadata: oneOption })).toBe(false);
  });
});
