import { RunnableConfig } from '@langchain/core/runnables';
import { ILessonBlock } from '@models/LessonContentModel';
import { LessonState } from '../state';

export const merge = async (state: LessonState, _config?: RunnableConfig): Promise<Partial<LessonState>> => {
  const allBlocks: ILessonBlock[] = [...state.contentBlocks, ...state.interactiveBlocks];

  // Place links block after everything
  if (state.linksBlock) {
    const maxOrder = Math.max(...allBlocks.map((b) => b.order), 0);
    state.linksBlock.order = maxOrder + 1;
    allBlocks.push(state.linksBlock);
  }

  console.log(`[merge] ✓ ${allBlocks.length} total blocks (${state.contentBlocks.length} content + ${state.interactiveBlocks.length} interactive + ${state.linksBlock ? 1 : 0} links)`.green);

  return {
    contentBlocks: allBlocks, // Overwrite with merged set
  };
};
