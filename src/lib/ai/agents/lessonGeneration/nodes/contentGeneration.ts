import { RunnableConfig } from '@langchain/core/runnables';
import { streamObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { LessonState } from '../state';
import { contentOutputSchema, LESSON_SYSTEM_PROMPT } from '../prompts';

export const contentGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  const writer = (config?.configurable?.writer as ((event: Record<string, unknown>) => void) | undefined);

  console.log(`[contentGeneration] Starting block-by-block generation...`.cyan);

  const result = streamObject({
    model: anthropic('claude-sonnet-4-6'),
    schema: contentOutputSchema,
    temperature: 0.3,
    messages: [
      {
        role: 'system' as const,
        content: LESSON_SYSTEM_PROMPT,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      {
        role: 'user' as const,
        content: state.humanMessage,
      },
    ],
  });

  let emittedCount = 0;

  for await (const partial of result.partialObjectStream) {
    const blocks = partial.blocks ?? [];

    // Emit new COMPLETE blocks as they arrive
    // Blocks generate sequentially: blocks[0] completes before blocks[1] starts
    while (emittedCount < blocks.length) {
      const block = blocks[emittedCount];
      // Check if block has all required fields (meaning it's fully generated)
      if (block && block.id && block.type && typeof block.content === 'string' && typeof block.order === 'number') {
        console.log(`[contentGeneration] → Block ${emittedCount}: ${block.id} (${block.type})`.gray);
        writer?.({ type: 'block', block });
        emittedCount++;
      } else {
        break; // Block still being generated — wait for next yield
      }
    }
  }

  const final = await result.object;
  console.log(`[contentGeneration] ✓ Complete: ${final.blocks.length} blocks`.green);

  return {
    contentBlocks: final.blocks,
    contentSummary: final.summary,
  };
};
