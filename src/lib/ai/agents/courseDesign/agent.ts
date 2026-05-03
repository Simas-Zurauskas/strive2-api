import { AIMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { chatLog } from '@lib/loggers';
import { chat, saveMessages } from './nodes';
import { StateAnnotation, State } from './state';
import { TOOLS } from './tools';
import { NodeFunction } from './types';

// ── Custom tools node ─────────────────────────────────────
// Wraps ToolNode to intercept modify_structure results and update state

const baseToolNode = new ToolNode(TOOLS);

const toolsWithStateUpdate: NodeFunction = async (state, config) => {
  const toolsStart = Date.now();
  chatLog.info('design:tool batch start');
  const result = await baseToolNode.invoke(state, config);
  const resultMessages = result.messages ?? [];

  resultMessages.forEach((msg: { name?: string; content?: unknown }, i: number) => {
    const contentLen = String(msg.content ?? '').length;
    chatLog.info(`design:tool result[${i}] name=${msg.name ?? '?'} content=${contentLen}c`);
  });

  // Check if modify_structure was called and succeeded
  for (const msg of resultMessages) {
    if (msg.name === 'modify_structure') {
      try {
        const parsed = JSON.parse(String(msg.content));
        if (parsed.success && parsed.modules) {
          chatLog.info(
            `design:tool batch done ms=${Date.now() - toolsStart} — modify_structure ok modules=${parsed.modules.length}`,
          );
          return {
            ...result,
            currentStructure: { modules: parsed.modules, reasoning: parsed.reasoning },
            structureModified: true,
            refinementCount: state.refinementCount + 1,
          };
        }
        chatLog.error(
          `design:tool batch done ms=${Date.now() - toolsStart} — modify_structure failed err=${parsed.error}`,
        );
      } catch {
        chatLog.error(
          `design:tool batch done ms=${Date.now() - toolsStart} — modify_structure unparseable result`,
        );
      }
    }
  }

  chatLog.info(`design:tool batch done ms=${Date.now() - toolsStart}`);
  return result;
};

// ── Routing ───────────────────────────────────────────────

const routeModelOutput = (state: State): string => {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCalls = (lastMessage as AIMessage).tool_calls;
  if (lastMessage && toolCalls?.length) {
    chatLog.info(
      `design:route → tools (${toolCalls.length} tool_call(s): ${toolCalls.map((tc) => tc.name).join(',')})`,
    );
    return 'tools';
  }
  chatLog.info('design:route → saveMessages (no tool_calls)');
  return 'saveMessages';
};

// ── Graph construction ────────────────────────────────────

const graph = new StateGraph(StateAnnotation)
  .addNode('chat', chat)
  .addNode('tools', toolsWithStateUpdate)
  .addNode('saveMessages', saveMessages)
  .addEdge(START, 'chat')
  .addConditionalEdges('chat', routeModelOutput, {
    tools: 'tools',
    saveMessages: 'saveMessages',
  })
  .addEdge('tools', 'chat')
  .addEdge('saveMessages', END);

export const courseDesignAgent = graph.compile();
