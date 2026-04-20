import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getInteractiveModel } from '@lib/langchain';
import { sanitizeLatex } from '@lib/latexSanitizer';
import { sanitizeArtifacts } from '@lib/artifactSanitizer';
import { bumpArtifactScrubStrips, bumpArtifactScrubGutted } from '@lib/metrics';
import { withRetry } from '@lib/retry';
import { QuizState } from '../state';
import { quizOutputSchema, MODULE_QUIZ_SYSTEM_PROMPT, quizQuestionSchema } from '../prompts';
import { shuffleQuizOptions } from './shuffleQuizOptions';

type QuizQuestion = z.infer<typeof quizQuestionSchema>;

const GUTTED_EXPLANATION_FALLBACK = 'See the source lessons for the rationale.';

/**
 * Run LaTeX + artifact sanitization on every text-bearing field of a
 * module-quiz question. Mirrors the lesson-generation path
 * (`sanitizeInteractiveBlock` in interactiveGeneration.ts) so both code
 * paths scrub in the same order with the same fallback behaviour.
 */
const sanitizeQuizQuestion = (question: QuizQuestion): { question: QuizQuestion; strips: number; gutted: number } => {
  let strips = 0;
  let gutted = 0;

  const scrub = (value: string, opts: { fallbackOnGut?: string } = {}): string => {
    const latexRes = sanitizeLatex(value);
    const artifactRes = sanitizeArtifacts(latexRes.text);
    if (artifactRes.stripped > 0) strips += artifactRes.stripped;
    if (artifactRes.gutted) {
      gutted += 1;
      if (opts.fallbackOnGut !== undefined) return opts.fallbackOnGut;
    }
    return artifactRes.text;
  };

  return {
    question: {
      ...question,
      question: scrub(question.question),
      options: question.options.map((opt) => scrub(opt)),
      explanation: scrub(question.explanation, { fallbackOnGut: GUTTED_EXPLANATION_FALLBACK }),
    },
    strips,
    gutted,
  };
};

export const quizGeneration = async (state: QuizState): Promise<Partial<QuizState>> => {
  console.log(`[quizGeneration] Generating module quiz for "${state.moduleName}"...`.cyan);

  try {
    const model = getInteractiveModel().withStructuredOutput(quizOutputSchema);
    const result = await withRetry(() =>
      model.invoke([new SystemMessage(MODULE_QUIZ_SYSTEM_PROMPT), new HumanMessage(state.humanMessage)]),
    );

    let totalStrips = 0;
    let totalGutted = 0;
    const sanitizedQuestions = result.questions.map((q) => {
      const { question, strips, gutted } = sanitizeQuizQuestion(q);
      totalStrips += strips;
      totalGutted += gutted;
      return question;
    });

    if (totalStrips > 0) {
      bumpArtifactScrubStrips(totalStrips);
      for (let i = 0; i < totalGutted; i++) bumpArtifactScrubGutted();
      console.warn(`[quizGeneration] ⚠ Artifact scrub: ${totalStrips} meta-phrase(s) removed${totalGutted > 0 ? `, ${totalGutted} explanation(s) gutted → fallback used` : ''}`.yellow);
    }

    const shuffledQuestions = sanitizedQuestions.map((question) => shuffleQuizOptions({ question }));

    console.log(`[quizGeneration] ✓ ${shuffledQuestions.length} questions generated`.green);
    return { questions: shuffledQuestions };
  } catch (e) {
    console.error(`[quizGeneration] ✗ Failed: ${e instanceof Error ? e.message : e}`.red);
    throw e;
  }
};
