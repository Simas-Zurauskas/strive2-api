import { RunnableConfig } from '@langchain/core/runnables';
import { ILessonBlock } from '@models/LessonContentModel';
import { genLog } from '@lib/loggers';
import { LessonState } from '../state';

export const merge = async (state: LessonState, _config?: RunnableConfig): Promise<Partial<LessonState>> => {
  const allBlocks: ILessonBlock[] = [...state.contentBlocks, ...state.interactiveBlocks];

  // Place links block after everything
  if (state.linksBlock) {
    const maxOrder = Math.max(...allBlocks.map((b) => b.order), 0);
    state.linksBlock.order = maxOrder + 1;
    allBlocks.push(state.linksBlock);
  }

  genLog.info(
    `lesson:merge total=${allBlocks.length} content=${state.contentBlocks.length} interactive=${state.interactiveBlocks.length} links=${state.linksBlock ? 1 : 0}`,
  );

  return {
    contentBlocks: allBlocks, // Overwrite with merged set
  };
};
