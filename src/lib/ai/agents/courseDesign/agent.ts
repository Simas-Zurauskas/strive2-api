import { AIMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { chatLog } from '@lib/loggers';
import { captureWarning } from '@lib/errorReporter';
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
        // The tool returned a structured failure. Track in Sentry so we can
        // see the rate of "tool said no" vs "tool result was malformed".
        captureWarning('design:modify_structure tool returned failure', {
          tags: { agent: 'courseDesign', node: 'tools' },
          extra: { error: String(parsed.error ?? 'unknown'), refinementCount: state.refinementCount },
          fingerprint: ['courseDesign', 'modify_structure', 'tool-failure'],
        });
      } catch (parseErr) {
        chatLog.error(
          `design:tool batch done ms=${Date.now() - toolsStart} — modify_structure unparseable result`,
        );
        // The tool result wasn't JSON. Silent in the original code; surface
        // here because the user-facing UX (the design chat) silently rolls
        // forward with the unchanged structure — the user will be confused
        // why their refinement didn't apply.
        captureWarning('design:modify_structure tool result unparseable', {
          tags: { agent: 'courseDesign', node: 'tools' },
          extra: {
            reason: parseErr instanceof Error ? parseErr.message : String(parseErr),
            contentPreview: String(msg.content ?? '').slice(0, 500),
          },
          fingerprint: ['courseDesign', 'modify_structure', 'unparseable'],
        });
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
