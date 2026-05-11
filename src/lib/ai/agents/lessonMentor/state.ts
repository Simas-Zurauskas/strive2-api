import { BaseMessage, BaseMessageLike } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { GoalType } from '@lib/constants';

/**
 * Session attachment shape carried through agent state. Only the fields
 * the chat node needs to assemble its system block — the canonical
 * record (with sha256, createdAt, etc.) lives on LessonMentorChatModel.
 */
export interface MentorAttachmentState {
  id: string;
  filename: string;
  kind: 'pdf' | 'text';
  approxTokens: number;
  text: string;
}

export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], BaseMessageLike[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // Lesson context — injected at invocation, read-only
  courseId: Annotation<string>(),
  userId: Annotation<string>(),
  moduleIndex: Annotation<number>(),
  lessonIndex: Annotation<number>(),
  lessonTitle: Annotation<string>(),
  moduleTitle: Annotation<string>(),
  courseGoal: Annotation<string>(),
  lessonContent: Annotation<string>(),
  courseDepth: Annotation<string>(),
  // `null` for legacy pre-classifier courses; the prompt builder defaults
  // it to `master` (the classifier's own safe default).
  goalType: Annotation<GoalType | null>(),
  learnerContext: Annotation<string>(),

  // All session-scoped attachments, loaded from the chat doc and
  // surfaced as a cached system block in the chat node. Empty array
  // when none — the chat node skips emitting the block in that case
  // so we don't burn a cache miss on a no-op block.
  attachments: Annotation<MentorAttachmentState[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  // Pointers for the user message we're about to save. Read by
  // saveMessages so the persisted message carries the chips that
  // should render on rehydration. Distinct from `attachments` (which
  // is the full session list) — we only persist the ones that this
  // turn explicitly attaches.
  pendingAttachmentIds: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
});

export type State = typeof StateAnnotation.State;
