import { HumanMessage, AIMessage, AIMessageChunk } from '@langchain/core/messages';
import CourseMentorChatModel, {
  type ICourseMentorChatHandoff,
} from '@models/CourseMentorChatModel';
import { chatLog } from '@lib/loggers';
import { extractHandoffsFromTurn } from '../../shared/extractHandoffsFromTurn';
import { NodeFunction } from '../types';

/**
 * Course-mentor persistence node — simpler than the lesson mentor's
 * because there are no per-message attachments to bind. Same per-turn
 * pattern: walk the state messages, pick the latest user + latest
 * non-tool-call assistant text, upsert into the chat doc.
 */

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
  handoffs?: ICourseMentorChatHandoff[];
}


export const saveMessages: NodeFunction = async (state) => {
  const { courseId, userId, messages } = state;

  chatLog.info(`course:save start stateMessages=${messages.length}`);

  // CRITICAL: only persist the CURRENT turn's exchange — never the
  // rehydrated history. Walking the entire state and picking the
  // "latest assistant with text" silently re-saved an older,
  // already-persisted assistant message whenever the current turn's
  // final response was empty (tool-only iteration that ran out of
  // text). That manifested as duplicated past replies in the chat
  // history doc on every turn that had no fresh assistant text.
  //
  // Semantically the current turn always starts at the LAST
  // HumanMessage in state.messages (everything before that is
  // rehydrated history; everything after is this turn's agent
  // iterations). Walk only `[lastUser, ..., end]`.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) {
    chatLog.warn('course:save no HumanMessage in state — nothing to persist');
    return {};
  }

  const userText = extractText(messages[lastUserIdx].content);
  if (!userText) {
    chatLog.warn('course:save new user message has empty content — skipping');
    return {};
  }
  const userMsg: SaveableMessage = { role: 'user', content: userText };

  // Concatenate every text contribution from AI messages this turn —
  // INCLUDING ones that also issued tool_calls. An iteration like
  // `text="You have 2 insights due..." tool_calls=1` produces visible
  // text the user reads before the tool fires; the old "no tool_calls"
  // filter silently dropped it on persist, so reload showed the
  // user's question with nothing after it. Joining with "\n\n"
  // preserves multi-iteration text the same way the user saw it
  // streamed.
  const assistantParts: string[] = [];
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m instanceof AIMessage || m instanceof AIMessageChunk) {
      const text = extractText(m.content);
      if (text) assistantParts.push(text);
    }
  }
  const handoffs = extractHandoffsFromTurn(messages, lastUserIdx + 1) as ICourseMentorChatHandoff[];
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
  await CourseMentorChatModel.findOneAndUpdate(
    { courseId, userId },
    { $push: { messages: { $each: toSave } } },
    { upsert: true, returnDocument: 'after' },
  );
  chatLog.info(
    `course:save done ms=${Date.now() - persistStart} saved=${toSave.length}${assistantMsg ? ` text=${assistantMsg.content.length}c` : ' assistant=none'}${handoffs.length > 0 ? ` handoffs=${handoffs.length}` : ''}`,
  );

  return {};
};
