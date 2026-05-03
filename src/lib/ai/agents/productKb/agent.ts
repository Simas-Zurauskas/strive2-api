import { AIMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { chatLog } from '@lib/loggers';
import { chat } from './nodes';
import { StateAnnotation, State } from './state';
import { TOOLS } from './tools';
import { NodeFunction } from './types';

// ── Routing ───────────────────────────────────────────────

const routeModelOutput = (state: State): string => {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCalls = (lastMessage as AIMessage).tool_calls;
  if (lastMessage && toolCalls?.length) {
    chatLog.info(
      `pkb:route → tools (${toolCalls.length} tool_call(s): ${toolCalls.map((tc) => tc.name).join(',')})`,
    );
    return 'tools';
  }
  chatLog.info('pkb:route → end (no tool_calls)');
  return END;
};

// ── Tools node with batch timing ──────────────────────────

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
    `pkb:tool batch done ms=${Date.now() - toolsStart} count=${resultMessages.length}${summary ? ` results=[${summary}]` : ''}`,
  );
  return result;
};

// ── Graph construction ────────────────────────────────────
//
// Simpler than the lesson-mentor graph: there's no saveMessages step
// because product-KB chat is ephemeral (no Mongo persistence in v1).
// Loop is chat → tools → chat → ... → END once the model stops calling
// tools.

const graph = new StateGraph(StateAnnotation)
  .addNode('chat', chat)
  .addNode('tools', toolsWithLogging)
  .addEdge(START, 'chat')
  .addConditionalEdges('chat', routeModelOutput, {
    tools: 'tools',
    [END]: END,
  })
  .addEdge('tools', 'chat');

export const productKbAgent = graph.compile();
