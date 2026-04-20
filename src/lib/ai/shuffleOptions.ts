/**
 * Fisher–Yates shuffle of an MCQ option list, with the correct-answer index
 * remapped to its new position. Shared by the module-quiz generation path
 * (top-level `options` + `correctIndex`) and the lesson-level interactive
 * quiz path (metadata-nested options + correctIndex).
 *
 * Pure function: returns a new object; does not mutate input.
 *
 * The LLM has a strong positional bias (correct answer clusters in early
 * positions). Shuffling once at generation time breaks the bias without
 * touching the index-based grading path.
 *
 * Invariant: `result.options[result.correctIndex] === options[correctIndex]`
 * for any valid input.
 */
export const shuffleOptionsWithCorrectIndex = ({
  options,
  correctIndex,
}: {
  options: string[];
  correctIndex: number;
}): { options: string[]; correctIndex: number } => {
  if (options.length < 2) return { options, correctIndex };

  const correctAnswer = options[correctIndex];
  const shuffled = [...options];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return {
    options: shuffled,
    correctIndex: shuffled.indexOf(correctAnswer),
  };
};
