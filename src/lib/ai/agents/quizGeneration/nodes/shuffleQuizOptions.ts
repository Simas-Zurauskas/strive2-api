import { z } from 'zod';
import { shuffleOptionsWithCorrectIndex } from '@lib/ai/shuffleOptions';
import { quizQuestionSchema } from '../prompts';

type QuizQuestion = z.infer<typeof quizQuestionSchema>;

/**
 * Shuffle a module-quiz question's options so the correct answer's position
 * is randomized, preserving the invariant that
 * `result.options[result.correctIndex] === question.options[question.correctIndex]`.
 *
 * Pure function. Delegates the Fisher–Yates + index-remap to the shared
 * primitive at `@lib/ai/shuffleOptions` so the lesson-level interactive
 * quiz path and this path can't drift.
 */
export const shuffleQuizOptions = ({ question }: { question: QuizQuestion }): QuizQuestion => {
  const { options, correctIndex } = shuffleOptionsWithCorrectIndex({
    options: question.options,
    correctIndex: question.correctIndex,
  });

  return {
    ...question,
    options,
    correctIndex,
  };
};
