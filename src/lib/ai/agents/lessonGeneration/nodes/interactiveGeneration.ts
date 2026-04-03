import { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getInteractiveModel } from '@lib/langchain';
import { withRetry } from '@lib/retry';
import { LessonState } from '../state';
import { interactiveOutputSchema, INTERACTIVE_SYSTEM_PROMPT } from '../prompts';

const formatBlocksForContext = (blocks: LessonState['contentBlocks']) => {
  return blocks
    .map((b) => `[order=${b.order}] [${b.type}] ${b.content}`)
    .join('\n\n');
};

export const interactiveGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  const writer = (config?.configurable?.writer as ((event: Record<string, unknown>) => void) | undefined);

  console.log(`[interactiveGeneration] Generating quizzes + exercise...`.cyan);

  const summaryBlock = state.contentBlocks.find((b) => b.type === 'summary');
  const maxContentOrder = Math.max(...state.contentBlocks.map((b) => b.order));

  const humanMessage = `## Lesson content

${formatBlocksForContext(state.contentBlocks)}

## Lesson info

Title: ${state.lessonName}
Description: ${state.lessonDescription}
Course depth: ${state.depth}

## Positioning instructions

The content blocks use order values 0 through ${maxContentOrder}.
- Place quiz blocks by inserting them between existing content blocks. Use decimal orders to insert between integers (e.g., 2.5 to place between order 2 and 3). Pick positions AFTER the section that teaches the concept being tested.
- Place the exercise block at order ${summaryBlock ? summaryBlock.order - 0.5 : maxContentOrder + 1} (just before the summary).

Generate 1-2 quiz blocks and 1 exercise block.`;

  try {
    const model = getInteractiveModel().withStructuredOutput(interactiveOutputSchema);
    const result = await withRetry(() =>
      model.invoke([new SystemMessage(INTERACTIVE_SYSTEM_PROMPT), new HumanMessage(humanMessage)]),
    );

    // Emit each interactive block
    for (const block of result.blocks) {
      console.log(`[interactiveGeneration] → ${block.id} (${block.type})`.gray);
      writer?.({ type: 'block', block });
    }

    console.log(`[interactiveGeneration] ✓ ${result.blocks.length} blocks`.green);
    return { interactiveBlocks: result.blocks };
  } catch (e) {
    console.warn(`[interactiveGeneration] ✗ Failed: ${e instanceof Error ? e.message : e}`.red);
    return { interactiveBlocks: [] };
  }
};
