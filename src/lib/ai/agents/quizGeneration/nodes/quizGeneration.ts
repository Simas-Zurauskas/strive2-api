import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getInteractiveModel } from '@lib/langchain';
import { withRetry } from '@lib/retry';
import { QuizState } from '../state';
import { quizOutputSchema, MODULE_QUIZ_SYSTEM_PROMPT } from '../prompts';

export const quizGeneration = async (state: QuizState): Promise<Partial<QuizState>> => {
  console.log(`[quizGeneration] Generating module quiz for "${state.moduleName}"...`.cyan);

  try {
    const model = getInteractiveModel().withStructuredOutput(quizOutputSchema);
    const result = await withRetry(() =>
      model.invoke([new SystemMessage(MODULE_QUIZ_SYSTEM_PROMPT), new HumanMessage(state.humanMessage)]),
    );

    console.log(`[quizGeneration] ✓ ${result.questions.length} questions generated`.green);
    return { questions: result.questions };
  } catch (e) {
    console.error(`[quizGeneration] ✗ Failed: ${e instanceof Error ? e.message : e}`.red);
    throw e;
  }
};
