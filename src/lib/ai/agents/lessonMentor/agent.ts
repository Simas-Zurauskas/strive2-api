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
      `lesson:route → tools (${toolCalls.length} tool_call(s): ${toolCalls.map((tc) => tc.name).join(',')})`,
    );
    return 'tools';
  }
  chatLog.info('lesson:route → saveMessages (no tool_calls)');
  return 'saveMessages';
};

// ── Tools node with batch timing ─────────────────────────────
// Wraps the standard ToolNode to log per-batch execution duration
// and the size of each ToolMessage produced. Per-tool internal
// instrumentation lives inside individual tool bodies if needed.

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
    `lesson:tool batch done ms=${Date.now() - toolsStart} count=${resultMessages.length}${summary ? ` results=[${summary}]` : ''}`,
  );
  return result;
};

// ── Graph construction ────────────────────────────────────

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

export const lessonMentorAgent = graph.compile();
