import { Annotation } from '@langchain/langgraph';
import { IModuleQuizQuestion } from '@models/ModuleQuizContentModel';

export const QuizStateAnnotation = Annotation.Root({
  // ── Input (set at invocation) ──────────────────────────
  courseId: Annotation<string>(),
  goal: Annotation<string>(),
  answers: Annotation<{ questionId: string; answer: string }[]>(),
  depth: Annotation<string>(),
  structure: Annotation<{
    modules: {
      name: string;
      description: string;
      lessons: { name: string; description: string }[];
    }[];
  }>(),
  moduleIndex: Annotation<number>(),

  // ── Derived (set by contextLoad) ───────────────────────
  moduleName: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  humanMessage: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),

  // ── Output (set by quizGeneration) ─────────────────────
  questions: Annotation<IModuleQuizQuestion[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
});

export type QuizState = typeof QuizStateAnnotation.State;
