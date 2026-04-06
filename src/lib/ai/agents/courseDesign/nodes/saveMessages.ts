import { HumanMessage, AIMessage, AIMessageChunk } from '@langchain/core/messages';
import CourseDesignChatModel from '@models/CourseDesignChatModel';
import CourseModel from '@models/CourseModel';
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

  console.log('[agent:saveMessages] ── Saving messages ──'.cyan);
  console.log(`[agent:saveMessages] Total messages in state: ${messages.length}, structureModified: ${structureModified}`.gray);

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

  console.log(`[agent:saveMessages] Saving ${toSave.length} messages to DB`.gray);
  toSave.forEach((m) => console.log(`[agent:saveMessages]   ${m.role}: ${m.content.slice(0, 80)}`.gray));

  if (toSave.length > 0) {
    await CourseDesignChatModel.findOneAndUpdate(
      { courseId, userId },
      { $push: { messages: { $each: toSave } } },
      { upsert: true, returnDocument: 'after' },
    );
    console.log('[agent:saveMessages] ✓ Messages persisted to ChatSession'.green);
  }

  // If structure was modified, persist to Course document
  if (structureModified && currentStructure) {
    await CourseModel.findByIdAndUpdate(courseId, {
      structure: currentStructure,
    });
    console.log(`[agent:saveMessages] ✓ Structure updated and persisted for course: ${courseId}`.green);
  }

  return {};
};
