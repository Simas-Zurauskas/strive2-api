import { HumanMessage, AIMessage, AIMessageChunk } from '@langchain/core/messages';
import CourseDesignChatModel from '@models/CourseDesignChatModel';
import CourseModel from '@models/CourseModel';
import { chat as chatLog } from '@lib/loggers';
import { NodeFunction } from '../types';

/** Extract plain text from a message content field (string or Anthropic content blocks). */
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

export const saveMessages: NodeFunction = async (state) => {
  const { courseId, userId, messages, structureModified, currentStructure } = state;

  chatLog.info(
    `design:save start stateMessages=${messages.length} structureModified=${structureModified}`,
  );

  // Extract user and assistant messages from this turn
  const newMessages: { role: 'user' | 'assistant'; content: string }[] = [];

  for (const msg of messages) {
    if (msg instanceof HumanMessage) {
      newMessages.push({ role: 'user', content: extractText(msg.content) });
    } else if ((msg instanceof AIMessage || msg instanceof AIMessageChunk) && !msg.tool_calls?.length) {
      // Only save non-tool-call AI messages (the final text response)
      const text = extractText(msg.content);
      if (text) {
        newMessages.push({ role: 'assistant', content: text });
      }
    }
  }

  // Keep only the last user message (the new turn) and the last assistant message (the response)
  const userMsg = [...newMessages].reverse().find((m) => m.role === 'user');
  const assistantMsg = [...newMessages].reverse().find((m) => m.role === 'assistant');

  const toSave = [userMsg, assistantMsg].filter(Boolean) as { role: 'user' | 'assistant'; content: string }[];

  if (toSave.length > 0) {
    const persistStart = Date.now();
    await CourseDesignChatModel.findOneAndUpdate(
      { courseId, userId },
      { $push: { messages: { $each: toSave } } },
      { upsert: true, returnDocument: 'after' },
    );
    const assistantSaved = toSave.find((m) => m.role === 'assistant');
    chatLog.info(
      `design:save done ms=${Date.now() - persistStart} saved=${toSave.length}${assistantSaved ? ` text=${assistantSaved.content.length}c` : ' assistant=none'}`,
    );
  } else {
    chatLog.warn('design:save nothing to persist (no user/assistant messages found)');
  }

  // If structure was modified, persist to Course document
  if (structureModified && currentStructure) {
    const courseUpdateStart = Date.now();
    await CourseModel.findByIdAndUpdate(courseId, {
      structure: currentStructure,
    });
    chatLog.info(
      `design:save structure-update done ms=${Date.now() - courseUpdateStart} course=${courseId}`,
    );
  }

  return {};
};
