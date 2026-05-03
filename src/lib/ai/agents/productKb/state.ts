import { BaseMessage, BaseMessageLike } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';

/**
 * Product-KB chat state.
 *
 * Deliberately minimal compared to the lesson-mentor state: there's no
 * course/lesson context, no attachments, no learner-progress block. The
 * agent grounds itself entirely in the `product-kb` Pinecone namespace
 * via the `search_product_kb` tool. Per-turn callers may pass `userId`
 * through `configurable` for cost attribution but the agent itself
 * never reads it from state.
 */

export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], BaseMessageLike[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

export type State = typeof StateAnnotation.State;
