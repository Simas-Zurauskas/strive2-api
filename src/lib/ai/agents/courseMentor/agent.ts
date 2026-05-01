import { AIMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { chat as chatLog } from '@lib/loggers';
import { chat, saveMessages } from './nodes';
import { StateAnnotation, State } from './state';
import { TOOLS } from './tools';
import { NodeFunction } from './types';

// ── Routing ───────────────────────────────────────────────

const routeModelOutput = (state: State): string => {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCalls = (lastMessage as AIMessage).tool_calls;
  if (lastMessage && toolCalls?.length) {
    chatLog.info(
      `course:route → tools (${toolCalls.length} tool_call(s): ${toolCalls.map((tc) => tc.name).join(',')})`,
    );
    return 'tools';
  }
  chatLog.info('course:route → saveMessages (no tool_calls)');
  return 'saveMessages';
};

// ── Tools node with batch timing ─────────────────────────────

const baseToolNode = new ToolNode(TOOLS);

const toolsWithLogging: NodeFunction = async (state, config) => {
  const toolsStart = Date.now();
  const result = (await baseToolNode.invoke(state, config)) as Partial<State> & {
    messages?: { name?: string; content?: unknown }[];
  };
  const resultMessages = result.messages ?? [];
  const summary = resultMessages
    .map((m) => `${m.name ?? '?'}=${String(m.content ?? '').length}c`)
    .join(',');
  chatLog.info(
    `course:tool batch done ms=${Date.now() - toolsStart} count=${resultMessages.length}${summary ? ` results=[${summary}]` : ''}`,
  );
  return result;
};

// ── Graph construction ────────────────────────────────────
//
// Identical topology to the lesson mentor: START → chat → (tool_calls?) →
// tools → chat | saveMessages → END. The tools-back-edge supports
// multi-turn tool usage within a single user message (e.g., a
// search_lesson_content followed by a get_user_progress within the
// same response).

const graph = new StateGraph(StateAnnotation)
  .addNode('chat', chat)
  .addNode('tools', toolsWithLogging)
  .addNode('saveMessages', saveMessages)
  .addEdge(START, 'chat')
  .addConditionalEdges('chat', routeModelOutput, {
    tools: 'tools',
    saveMessages: 'saveMessages',
  })
  .addEdge('tools', 'chat')
  .addEdge('saveMessages', END);

export const courseMentorAgent = graph.compile();
