import { Annotation } from '@langchain/langgraph';
import { ILessonBlock } from '@models/LessonContentModel';

export const LessonStateAnnotation = Annotation.Root({
  // ── Input (set at invocation) ──────────────────────────
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
  lessonIndex: Annotation<number>(),
  includeImage: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => true,
  }),
  includeLinks: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => true,
  }),

  // ── Derived (set by contextLoad) ───────────────────────
  humanMessage: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  lessonName: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  lessonDescription: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  moduleName: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),

  // ── Output (accumulated across nodes) ──────────────────
  contentBlocks: Annotation<ILessonBlock[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  contentSummary: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  interactiveBlocks: Annotation<ILessonBlock[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  heroImageUrl: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  linksBlock: Annotation<ILessonBlock | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type LessonState = typeof LessonStateAnnotation.State;
