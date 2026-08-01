import { Annotation } from '@langchain/langgraph';
import { CourseDomain, CourseSource, SourceFidelity } from '@lib/constants';
import { ILessonBlock } from '@models/LessonContentModel';
import { GeneratedRecallCard } from '@services/recallContentService';

export const LessonStateAnnotation = Annotation.Root({
  // ── Input (set at invocation) ──────────────────────────
  courseId: Annotation<string>(),
  goal: Annotation<string>(),
  answers: Annotation<{ questionId: string; answer: string }[]>(),
  depth: Annotation<string>(),
  domain: Annotation<CourseDomain | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  structure: Annotation<{
    modules: {
      name: string;
      description: string;
      // `sourceRefs` (documents courses only, validated chunk vectorIds)
      // rides on the persisted structure lessons — optional so goal-course
      // structures type-check unchanged.
      lessons: { name: string; description: string; sourceRefs?: string[] }[];
    }[];
  }>(),
  // ── Documents-course grounding inputs (Phase 5, additive) ──
  // Null on goal courses — contextLoad's retrieval and the prompts'
  // grounding section are gated entirely on these.
  source: Annotation<CourseSource | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  sourceFidelity: Annotation<SourceFidelity | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
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
  // Recall cards are the highest-value optional feature pedagogically
  // (spaced repetition + retrieval practice), so they default ON. Users
  // can opt out per lesson at generation time, then regenerate on demand
  // from inside the lesson if they change their mind.
  includeRecallCards: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => true,
  }),

  // ── Derived (set by contextLoad) ───────────────────────
  humanMessage: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  // True only when contextLoad actually injected a source-material section
  // into humanMessage (documents course + non-empty retrieval). Gates the
  // grounding section of the lesson system prompt — false keeps the
  // goal-course system prompt byte-identical.
  hasSourceMaterial: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
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
  recallCards: Annotation<GeneratedRecallCard[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
});

export type LessonState = typeof LessonStateAnnotation.State;
