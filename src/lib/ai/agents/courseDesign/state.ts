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

  // Depth-recommendation context from depthPreviews. All optional — legacy
  // courses persisted before these fields existed leave them undefined and
  // the system prompt instructs the agent to proceed without them.
  // Surfaced so the mentor can ground depth/scope/fit answers in the
  // model's actual recommendation when the learner asks (the agent does
  // NOT raise depth proactively — see prompts.ts).
  recommendedDepth: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  recommendationReason: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  overcommitRisk: Annotation<'low' | 'moderate' | 'high' | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  overcommitRationale: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  undercommitRisk: Annotation<'low' | 'moderate' | 'high' | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  undercommitRationale: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  recommendedLessonCountRange: Annotation<[number, number] | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  recommendedHoursRange: Annotation<[number, number] | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),

  // Documents-course grounding (FEEDBACK-1). Set only when the course was
  // built from uploaded documents AND its assessment carries a clamping
  // size band — the chat prompt then states the allowed lesson range and
  // fidelity posture (pairs with modify_structure's band enforcement).
  // Undefined on goal courses and legacy rows; the prompt handles absence.
  sourceFidelity: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  sourceLessonRange: Annotation<[number, number] | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),

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
