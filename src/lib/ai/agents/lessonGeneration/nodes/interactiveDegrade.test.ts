/**
 * AC2 — a degraded lesson must never become a failed lesson.
 *
 * The predicate tests in `interactiveQuizShape.test.ts` prove the count-floor
 * REJECTS the right shapes. They say nothing about what the node then does,
 * and that control flow is the risky half of the fix: tightening the floor
 * without a degrade path would have traded "a lesson with one invisible quiz"
 * for "a lesson with NO interactive blocks at all", because the function's
 * outer catch returns `{ interactiveBlocks: [] }` on any throw.
 *
 * These tests drive the real node with a stubbed model, which nothing else in
 * the suite does — the node's retry/escalation flow had zero integration
 * coverage before this file.
 *
 * Run: yarn test interactiveDegrade
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const { fakeUtilityInvoke, fakeInteractiveInvoke } = vi.hoisted(() => ({
  fakeUtilityInvoke: vi.fn(),
  fakeInteractiveInvoke: vi.fn(),
}));

// `withStructuredOutput` returns the object whose `.invoke` the node calls.
vi.mock('@lib/langchain', () => ({
  getUtilityModel: () => ({ withStructuredOutput: () => ({ invoke: fakeUtilityInvoke }) }),
  getInteractiveModel: () => ({ withStructuredOutput: () => ({ invoke: fakeInteractiveInvoke }) }),
}));

// Keep the retry loop fast and single-shot: this file is about the node's
// escalate/degrade decision, not about backoff.
vi.mock('@lib/retry', () => ({
  withRetry: async <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('@lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/metrics')>();
  return { ...actual, bumpInteractiveMalformedQuizShipped: vi.fn() };
});

import { interactiveGeneration } from './interactiveGeneration';
import { bumpInteractiveMalformedQuizShipped } from '@lib/metrics';

const exercise = {
  id: 'ex-1',
  type: 'exercise',
  content: 'Write a function that returns the sum.',
  metadata: { language: 'python', starterCode: 'def add(a, b):' },
  order: 3,
};
const goodQuiz = {
  id: 'quiz-good',
  type: 'quiz',
  content: '',
  metadata: { question: 'What is 2+2?', options: ['3', '4'], correctIndex: 1 },
  order: 2,
};
/** Exactly the August shape: typed quiz, null metadata, question in prose. */
const deadQuiz = {
  id: 'quiz-dead',
  type: 'quiz',
  content: '## Quiz\n\n**Q1:** Which is correct?\n\n- A) one\n- B) two\n\n**Answers:** B.',
  metadata: null,
  order: 4,
};

const state = {
  courseId: 'c1',
  lessonTitle: 'A lesson',
  lessonDescription: 'desc',
  moduleTitle: 'A module',
  domain: null, // no explicit domain — takes buildLessonDomainSection's null branch
  depth: 'comprehensive',
  goal: 'Learn the thing',
  answers: [],
  contentBlocks: [
    { id: 'intro-1', type: 'intro', content: 'Opening paragraph.', metadata: null, order: 0 },
    { id: 'sec-1', type: 'section', content: '## A section\n\nSome teaching prose.', metadata: null, order: 1 },
    { id: 'sum-1', type: 'summary', content: 'The summary.', metadata: null, order: 9 },
  ],
} as never;

beforeEach(() => {
  fakeUtilityInvoke.mockReset();
  fakeInteractiveInvoke.mockReset();
  vi.mocked(bumpInteractiveMalformedQuizShipped).mockReset();
});

describe('AC2 — malformed quiz degrades, never throws away the lesson', () => {
  test('every attempt malformed → RESOLVES with blocks, counter bumped once', async () => {
    // Both tiers keep returning the dead shape. The node must ship what it
    // has rather than let the outer catch flatten it to zero blocks.
    fakeUtilityInvoke.mockResolvedValue({ blocks: [deadQuiz, exercise] });
    fakeInteractiveInvoke.mockResolvedValue({ blocks: [deadQuiz, exercise] });

    const out = await interactiveGeneration(state);

    expect(out.interactiveBlocks).toBeDefined();
    expect(out.interactiveBlocks!.length).toBeGreaterThan(0);
    expect(vi.mocked(bumpInteractiveMalformedQuizShipped)).toHaveBeenCalledOnce();
  });

  test('the GOOD exercise survives the degrade — the batch is not discarded', async () => {
    // The whole point of degrading rather than throwing: a bad quiz must not
    // cost the learner the exercise that generated fine alongside it.
    fakeUtilityInvoke.mockResolvedValue({ blocks: [deadQuiz, exercise] });
    fakeInteractiveInvoke.mockResolvedValue({ blocks: [deadQuiz, exercise] });

    const out = await interactiveGeneration(state);
    const types = (out.interactiveBlocks ?? []).map((b) => b.type);
    expect(types).toContain('exercise');
  });

  test("the dead quiz's PROSE survives, so the client fallback has something to render", async () => {
    fakeUtilityInvoke.mockResolvedValue({ blocks: [deadQuiz, exercise] });
    fakeInteractiveInvoke.mockResolvedValue({ blocks: [deadQuiz, exercise] });

    const out = await interactiveGeneration(state);
    const dead = (out.interactiveBlocks ?? []).find((b) => b.type === 'quiz');
    expect(dead).toBeDefined();
    expect(dead!.content).toContain('Which is correct?');
  });

  test('a clean first response ships without escalating or counting a degrade', async () => {
    // Guard against over-correction: the happy path must not have become
    // slower or start reporting failures.
    fakeUtilityInvoke.mockResolvedValue({ blocks: [goodQuiz, exercise] });

    const out = await interactiveGeneration(state);

    expect(out.interactiveBlocks!.some((b) => b.type === 'quiz')).toBe(true);
    expect(fakeInteractiveInvoke).not.toHaveBeenCalled();
    expect(vi.mocked(bumpInteractiveMalformedQuizShipped)).not.toHaveBeenCalled();
  });

  test('Haiku malformed → escalates to Sonnet; a good Sonnet response ships clean', async () => {
    // Proves the fix actually engages the escalation machinery that the
    // type-only floor never triggered.
    fakeUtilityInvoke.mockResolvedValue({ blocks: [deadQuiz, exercise] });
    fakeInteractiveInvoke.mockResolvedValue({ blocks: [goodQuiz, exercise] });

    const out = await interactiveGeneration(state);

    expect(fakeInteractiveInvoke).toHaveBeenCalled();
    expect(vi.mocked(bumpInteractiveMalformedQuizShipped)).not.toHaveBeenCalled();
    const quiz = (out.interactiveBlocks ?? []).find((b) => b.type === 'quiz');
    expect(quiz?.metadata).toBeTruthy();
  });

  test('a MIXED batch (one good, one dead) also escalates — the aggregate-floor hole', async () => {
    // Under a `wellFormed >= 1` floor this would have passed on attempt 1 and
    // shipped the dead block untouched. It must escalate instead.
    fakeUtilityInvoke.mockResolvedValue({ blocks: [goodQuiz, deadQuiz, exercise] });
    fakeInteractiveInvoke.mockResolvedValue({ blocks: [goodQuiz, exercise] });

    await interactiveGeneration(state);
    expect(fakeInteractiveInvoke).toHaveBeenCalled();
  });

  test('a hard model outage still returns empty blocks rather than propagating', async () => {
    // `lastAttemptOutput` is undefined here (nothing ever returned), so the
    // degrade branch must NOT fire and the outer catch handles it.
    fakeUtilityInvoke.mockRejectedValue(new Error('provider down'));
    fakeInteractiveInvoke.mockRejectedValue(new Error('provider down'));

    const out = await interactiveGeneration(state);

    expect(out.interactiveBlocks).toEqual([]);
    expect(vi.mocked(bumpInteractiveMalformedQuizShipped)).not.toHaveBeenCalled();
  });
});
