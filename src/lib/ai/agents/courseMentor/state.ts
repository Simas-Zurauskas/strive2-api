import { BaseMessage, BaseMessageLike } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';

/**
 * Course-scoped mentor state. Distinct from `lessonMentor/state.ts`:
 *   - No `moduleIndex` / `lessonIndex` — the course mentor is course-wide.
 *   - No `lessonContent` — the course mentor never injects lesson content;
 *     it uses `search_lesson_content` (RAG) for cross-lesson retrieval.
 *   - No `attachments` — file uploads aren't supported at this scope in v1.
 *
 * The chat node assembles its system prompt from `courseGoal`, `courseDepth`,
 * `courseSummary` (a markdown block listing every module + lessons +
 * progress status), and `learnerContext` (aggregated progress signals).
 */
export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], BaseMessageLike[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // Course context — injected at invocation, read-only inside the graph.
  courseId: Annotation<string>(),
  userId: Annotation<string>(),
  courseGoal: Annotation<string>(),
  courseDepth: Annotation<string>(),
  courseSummary: Annotation<string>(),
  learnerContext: Annotation<string>(),
});

export type State = typeof StateAnnotation.State;
