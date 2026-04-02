import { BaseMessage, BaseMessageLike } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';

export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], BaseMessageLike[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // Course context — injected at invocation, read-only
  courseId: Annotation<string>(),
  userId: Annotation<string>(),
  goal: Annotation<string>(),
  answers: Annotation<{ questionId: string; answer: string }[]>(),
  depth: Annotation<string>(),

  // Current structure — replace-reducer so modify_structure tool can update it
  currentStructure: Annotation<{
    reasoning: {
      learnerProfile: string;
      topicAnalysis: string;
      scopeDecisions: string;
      progressionStrategy: string;
    };
    modules: {
      name: string;
      description: string;
      lessons: { name: string; description: string }[];
    }[];
  }>({
    reducer: (_prev, next) => next,
    default: () => ({
      reasoning: {
        learnerProfile: '',
        topicAnalysis: '',
        scopeDecisions: '',
        progressionStrategy: '',
      },
      modules: [],
    }),
  }),

  // Tracking
  structureModified: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  refinementCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});

export type State = typeof StateAnnotation.State;
