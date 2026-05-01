import { EventEmitter } from 'events';
import type { Response } from 'express';
import { chat } from '@lib/loggers';

/**
 * SSE orchestration shared between the course-mentor and lesson-mentor
 * controllers (and any future raw-Anthropic mentor agent that uses the
 * same `tokenEmitter` contract). Captures the streaming pattern that
 * was duplicated nearly verbatim in both controllers:
 *
 *   1. Set up `tokenEmitter` listeners for `'token'` and `'tool'`.
 *      Sticky `anyTextEmitted` / `anyToolEmitted` flags so the
 *      empty-response fallback only fires when the turn produced
 *      nothing at all (text OR a tool/handoff button).
 *   2. Invoke the agent with the caller's input + configurable.
 *      On error after SSE has been flushed, emit an `{ type: 'error' }`
 *      event then `[DONE]` rather than letting the error reach
 *      Express's JSON error handler (which would crash because
 *      `flushHeaders()` already committed text/event-stream).
 *   3. Walk the agent's final state for ToolMessages, parse each
 *      tool result into a JSON value, and include it in the
 *      `tool-output-available` SSE event. Without this the client
 *      receives `output: undefined` and downstream renderers (the
 *      handoff button, search-hit count badges) have nothing to act on.
 *   4. Close the text part with `text-end` if streaming was open;
 *      otherwise emit a brief fallback when the turn produced
 *      genuinely nothing visible.
 *   5. Send `[DONE]`, end the response.
 *
 * The caller passes `agent.invoke` and the agent's input/configurable;
 * we don't tie this helper to any particular agent type. Errors during
 * `agent.invoke` are converted to SSE events; pre-invoke errors should
 * be handled by the caller before flushing headers.
 *
 * Returns whether the request streamed to completion. Callers use this
 * to decide whether to debit credits — a failed/aborted run shouldn't
 * charge the user for credits the agent did consume mid-flight (those
 * are tracked separately via the usage context and recovered at the
 * accumulator level), but a SUCCESSFUL run should debit. The caller
 * still owns the debit call to keep job-type metadata explicit.
 */

interface ToolEvent {
  toolName: string;
  toolCallId: string;
}

interface AgentLikeMessage {
  _getType?: () => string;
  tool_call_id?: string;
  content?: unknown;
}

interface AgentLikeState {
  messages?: unknown[];
}

interface RunMentorAgentStreamArgs<TInput, TConfigurable extends Record<string, unknown>> {
  res: Response;
  abortController: AbortController;
  /** Driven by the caller's `res.on('close')` — flips false when client disconnects. */
  isClientConnected: () => boolean;
  agent: { invoke: (input: TInput, runtime: { configurable: TConfigurable }) => Promise<unknown> };
  agentInput: TInput;
  agentConfigurable: TConfigurable;
  /**
   * Scope tag for chat logger lines (e.g. `'lesson'`, `'course'`). All
   * stream events from this helper are tagged `<scope>:stream`.
   */
  scope: string;
}

interface RunMentorAgentStreamResult {
  ok: boolean;
}

/** Write a single Vercel-AI-SDK-v1 ui-message-stream SSE event. */
const writeSSE = (res: Response, payload: Record<string, unknown>): void => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

export const runMentorAgentStream = async <
  TInput,
  TConfigurable extends { tokenEmitter: EventEmitter; abortSignal: AbortSignal },
>({
  res,
  abortController,
  isClientConnected,
  agent,
  agentInput,
  agentConfigurable,
  scope,
}: RunMentorAgentStreamArgs<TInput, TConfigurable>): Promise<RunMentorAgentStreamResult> => {
  const tokenEmitter = agentConfigurable.tokenEmitter;
  const streamStart = Date.now();
  let textStarted = false;
  // Sticky flags — once true, never reset. Used to gate the empty-
  // response fallback below: `textStarted` flips back to false when a
  // tool block follows visible text, so it can't tell us whether ANY
  // text was emitted across the whole turn. Same for tools.
  let anyTextEmitted = false;
  let anyToolEmitted = false;
  let totalTextChars = 0;
  let totalTokenEvents = 0;
  let totalToolEvents = 0;
  const textPartId = `text-${Date.now()}`;
  const pendingToolCalls: ToolEvent[] = [];

  tokenEmitter.on('token', (token: string) => {
    if (!token || !isClientConnected()) return;
    if (!textStarted) {
      for (const tc of pendingToolCalls) {
        writeSSE(res, { type: 'tool-output-available', toolCallId: tc.toolCallId });
      }
      pendingToolCalls.length = 0;
      writeSSE(res, { type: 'text-start', id: textPartId });
      textStarted = true;
      anyTextEmitted = true;
    }
    totalTokenEvents += 1;
    totalTextChars += token.length;
    writeSSE(res, { type: 'text-delta', delta: token, id: textPartId });
  });

  tokenEmitter.on('tool', ({ toolName, toolCallId }: ToolEvent) => {
    if (!isClientConnected()) return;
    if (textStarted) {
      writeSSE(res, { type: 'text-end', id: textPartId });
      textStarted = false;
    }
    writeSSE(res, { type: 'tool-input-start', toolCallId, toolName, dynamic: true });
    writeSSE(res, { type: 'tool-input-available', toolCallId, toolName });
    pendingToolCalls.push({ toolCallId, toolName });
    anyToolEmitted = true;
    totalToolEvents += 1;
    chat.info(`${scope}:stream tool emit name=${toolName} id=${toolCallId}`);
  });

  let finalState: AgentLikeState | undefined;
  try {
    finalState = (await agent.invoke(agentInput, {
      configurable: { ...agentConfigurable, abortSignal: abortController.signal } as TConfigurable,
    })) as AgentLikeState;
  } catch (err) {
    if (!isClientConnected()) {
      chat.warn(`${scope}:stream agent invoke aborted post-disconnect ms=${Date.now() - streamStart}`);
      return { ok: false };
    }
    const message = err instanceof Error ? err.message : 'Agent error';
    writeSSE(res, { type: 'error', error: message });
    res.write('data: [DONE]\n\n');
    res.end();
    chat.error(
      `${scope}:stream agent error after SSE flush ms=${Date.now() - streamStart} err=${message}`,
    );
    return { ok: false };
  }

  if (!isClientConnected()) {
    chat.warn(`${scope}:stream client gone before tool-result flush ms=${Date.now() - streamStart}`);
    return { ok: false };
  }

  // Extract tool results from the agent's final state. Without this,
  // `tool-output-available` lands with no `output` and downstream
  // consumers (HandoffButton's parseHandoffSuccess, search-hit detail
  // renderer) silently see `undefined` — the agent's tools execute
  // correctly server-side but their effects are invisible.
  const toolResults = new Map<string, unknown>();
  for (const rawMsg of finalState?.messages ?? []) {
    const m = rawMsg as AgentLikeMessage;
    if (m._getType?.() === 'tool' && typeof m.tool_call_id === 'string') {
      let parsed: unknown = m.content;
      if (typeof m.content === 'string') {
        try {
          parsed = JSON.parse(m.content);
        } catch {
          parsed = m.content;
        }
      }
      toolResults.set(m.tool_call_id, parsed);
    }
  }

  for (const tc of pendingToolCalls) {
    const output = toolResults.get(tc.toolCallId);
    writeSSE(res, {
      type: 'tool-output-available',
      toolCallId: tc.toolCallId,
      ...(output !== undefined ? { output } : {}),
    });
  }
  pendingToolCalls.length = 0;

  if (textStarted) {
    writeSSE(res, { type: 'text-end', id: textPartId });
  } else if (!anyTextEmitted && !anyToolEmitted) {
    // Fallback only when the turn produced NOTHING — neither text nor
    // a tool/handoff button. A turn that rendered a button without a
    // preamble is still a valid response (user gets the button); the
    // fallback would just append a misleading "I don't have a clear
    // answer" beneath a working handoff.
    const fallbackId = `text-fallback-${Date.now()}`;
    const fallbackText =
      "I don't have a clear answer to that right now. Could you rephrase or give me more context?";
    writeSSE(res, { type: 'text-start', id: fallbackId });
    writeSSE(res, { type: 'text-delta', delta: fallbackText, id: fallbackId });
    writeSSE(res, { type: 'text-end', id: fallbackId });
    chat.warn(`${scope}:fallback agent emitted no text and no tools — sent fallback`);
  }
  res.write('data: [DONE]\n\n');
  res.end();

  chat.info(
    `${scope}:stream done ms=${Date.now() - streamStart} text=${totalTextChars}c tokens=${totalTokenEvents} toolEmits=${totalToolEvents} toolResults=${toolResults.size}`,
  );

  return { ok: true };
};
