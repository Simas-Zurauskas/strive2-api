import { HumanMessage, AIMessage, AIMessageChunk } from '@langchain/core/messages';
import LessonMentorChatModel, {
  type ILessonMentorChatHandoff,
} from '@models/LessonMentorChatModel';
import { chatLog } from '@lib/loggers';
import { extractHandoffsFromTurn } from '../../shared/extractHandoffsFromTurn';
import { NodeFunction } from '../types';

const extractText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: { type?: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('');
  }
  return String(content);
};

interface SaveableMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: { attachmentId: string }[];
  handoffs?: ILessonMentorChatHandoff[];
}


export const saveMessages: NodeFunction = async (state) => {
  const { courseId, userId, moduleIndex, lessonIndex, messages, pendingAttachmentIds } = state;

  chatLog.info(`lesson:save start stateMessages=${messages.length}`);

  // CRITICAL: only persist the CURRENT turn's exchange — never the
  // rehydrated history. Walking the entire state and picking the
  // "latest assistant with text" silently re-saved an older,
  // already-persisted assistant message whenever the current turn's
  // final response was empty (tool-only iteration that ran out of
  // text). That manifested as duplicated past replies on every turn
  // that had no fresh assistant text. The current turn always starts
  // at the LAST HumanMessage in state.messages.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) {
    chatLog.warn('lesson:save no HumanMessage in state — nothing to persist');
    return {};
  }

  const userText = extractText(messages[lastUserIdx].content);
  if (!userText) {
    chatLog.warn('lesson:save new user message has empty content — skipping');
    return {};
  }
  const userMsg: SaveableMessage = { role: 'user', content: userText };

  // Decorate the user message with the per-turn attachment pointers so
  // chips render on rehydration. Only the user message gets
  // attachments — the assistant doesn't "own" the file.
  if (pendingAttachmentIds && pendingAttachmentIds.length > 0) {
    userMsg.attachments = pendingAttachmentIds.map((id) => ({ attachmentId: id }));
  }

  // Concatenate every text contribution from AI messages this turn —
  // INCLUDING ones that also issued tool_calls. An iteration like
  // `text="..." tool_calls=1` produces visible text the user reads
  // before the tool fires; filtering on "no tool_calls" silently
  // dropped that text on persist, so reload showed the user's
  // question with nothing after it.
  const assistantParts: string[] = [];
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m instanceof AIMessage || m instanceof AIMessageChunk) {
      const text = extractText(m.content);
      if (text) assistantParts.push(text);
    }
  }
  const handoffs = extractHandoffsFromTurn(messages, lastUserIdx + 1) as ILessonMentorChatHandoff[];
  const assistantMsg: SaveableMessage | null =
    assistantParts.length > 0
      ? {
          role: 'assistant',
          content: assistantParts.join('\n\n'),
          ...(handoffs.length > 0 ? { handoffs } : {}),
        }
      : null;

  const toSave: SaveableMessage[] = [userMsg];
  if (assistantMsg) toSave.push(assistantMsg);

  const persistStart = Date.now();
  await LessonMentorChatModel.findOneAndUpdate(
    { courseId, userId, moduleIndex, lessonIndex },
    { $push: { messages: { $each: toSave } } },
    { upsert: true, returnDocument: 'after' },
  );
  chatLog.info(
    `lesson:save done ms=${Date.now() - persistStart} saved=${toSave.length}${userMsg.attachments?.length ? ` attachments=${userMsg.attachments.length}` : ''}${assistantMsg ? ` text=${assistantMsg.content.length}c` : ' assistant=none'}${handoffs.length > 0 ? ` handoffs=${handoffs.length}` : ''}`,
  );

  return {};
};
