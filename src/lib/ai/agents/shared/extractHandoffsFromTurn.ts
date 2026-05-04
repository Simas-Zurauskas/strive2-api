import { AIMessage, AIMessageChunk, ToolMessage } from '@langchain/core/messages';

/**
 * Pull successful `emit_handoff` results out of one turn's ToolMessages
 * so the saveMessages node can persist them alongside the assistant
 * text. The shape mirrors what `validateHandoff` produces in the shared
 * tool — see `emitHandoffTool.ts`. Each agent (course mentor / lesson
 * mentor) calls this with its own narrowed handoff TS type and casts
 * the result; the runtime check is identical for both, so we share
 * one implementation.
 *
 * Failures (`ok: false`) are intentionally dropped — they were
 * transient signals to the agent during the live turn (e.g. "module
 * not ready, try again with the right index"), not durable response
 * artifacts. The agent's next iteration would have either retried with
 * valid params (success → persisted) or fallen back to plain text.
 */
export interface PersistedMentorHandoff {
  target: 'quiz' | 'recall' | 'lesson';
  moduleIndex?: number;
  lessonIndex?: number;
  label: string;
}

export const extractHandoffsFromTurn = (
  messages: unknown[],
  startIdx: number,
): PersistedMentorHandoff[] => {
  const handoffs: PersistedMentorHandoff[] = [];

  // Build a lookup of tool_call_id → was-an-emit_handoff-call. Walking
  // forward to populate, then backward (or forward) to consume keeps
  // the loop simple — `messages` is bounded by one turn (typically
  // 2–6 entries) so the second pass is negligible.
  const handoffCallIds = new Set<string>();
  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i];
    if (m instanceof AIMessage || m instanceof AIMessageChunk) {
      for (const tc of m.tool_calls ?? []) {
        if (tc.name === 'emit_handoff' && tc.id) handoffCallIds.add(tc.id);
      }
    }
  }

  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i];
    if (!(m instanceof ToolMessage)) continue;
    if (typeof m.tool_call_id !== 'string') continue;
    if (!handoffCallIds.has(m.tool_call_id)) continue;
    // emit_handoff returns a JSON string from its tool function. Skip
    // any non-string ToolMessage shape — only the canonical success
    // payload should be persisted.
    if (typeof m.content !== 'string') continue;
    let parsed: { ok?: unknown; target?: unknown; moduleIndex?: unknown; lessonIndex?: unknown; label?: unknown };
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (parsed?.ok !== true) continue;
    const target = parsed.target;
    const label = parsed.label;
    if (target !== 'quiz' && target !== 'recall' && target !== 'lesson') continue;
    if (typeof label !== 'string' || label.length === 0) continue;
    handoffs.push({
      target,
      moduleIndex: typeof parsed.moduleIndex === 'number' ? parsed.moduleIndex : undefined,
      lessonIndex: typeof parsed.lessonIndex === 'number' ? parsed.lessonIndex : undefined,
      label,
    });
  }

  return handoffs;
};
