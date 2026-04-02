import { AIMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { chat, saveMessages } from './nodes';
import { StateAnnotation, State } from './state';
import { TOOLS } from './tools';
import { NodeFunction } from './types';

// ── Custom tools node ─────────────────────────────────────
// Wraps ToolNode to intercept modify_structure results and update state

const baseToolNode = new ToolNode(TOOLS);

const toolsWithStateUpdate: NodeFunction = async (state, config) => {
  console.log('[agent:tools] ── Executing tools ──'.cyan);
  const result = await baseToolNode.invoke(state, config);
  const resultMessages = result.messages ?? [];

  resultMessages.forEach((msg: { name?: string; content?: unknown }, i: number) => {
    const content = String(msg.content ?? '').slice(0, 150);
    console.log(`[agent:tools]   result[${i}]: name=${msg.name ?? '?'} content=${content}`.gray);
  });

  // Check if modify_structure was called and succeeded
  for (const msg of resultMessages) {
    if (msg.name === 'modify_structure') {
      try {
        const parsed = JSON.parse(String(msg.content));
        if (parsed.success && parsed.modules) {
          console.log(`[agent:tools] ✓ modify_structure succeeded — ${parsed.modules.length} modules`.green);
          return {
            ...result,
            currentStructure: { modules: parsed.modules, reasoning: parsed.reasoning },
            structureModified: true,
            refinementCount: state.refinementCount + 1,
          };
        }
        console.log(`[agent:tools] ✗ modify_structure failed: ${parsed.error}`.red);
      } catch {
        console.log('[agent:tools] ✗ modify_structure — failed to parse result'.red);
      }
    }
  }

  return result;
};

// ── Routing ───────────────────────────────────────────────

const routeModelOutput = (state: State): string => {
  const lastMessage = state.messages[state.messages.length - 1];
  if (lastMessage && (lastMessage as AIMessage).tool_calls?.length) {
    console.log('[agent:route] → tools (tool_calls detected)'.yellow);
    return 'tools';
  }
  console.log('[agent:route] → saveMessages (no tool_calls)'.yellow);
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
