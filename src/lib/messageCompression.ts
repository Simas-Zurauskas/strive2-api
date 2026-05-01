import { HumanMessage } from '@langchain/core/messages';
import { getUtilityModel } from '@lib/langchain';
import { chat } from '@lib/loggers';

/**
 * Rolling-summary chat-history compression.
 *
 * Used by both mentor chats (lesson + course). The persisted chat doc
 * keeps the full transcript plus an optional `summary` subdoc that
 * captures everything older than the live tail. Each request:
 *
 *   1. Read the persisted summary (if any) — it covers messages
 *      `[0, upToMessageCount)` and is bounded to ~800 chars.
 *   2. Compute the *uncovered* slice (everything since the last
 *      summary). When that slice grows past `keepRecent +
 *      refreshThreshold`, summarise the excess (real text — no
 *      per-message pre-truncation) into a fresh rolling summary.
 *   3. Feed the LLM `[summaryTurn?, ...lastKeepRecentMessagesVerbatim]`
 *      plus the new user turn appended by the caller.
 *
 * This makes per-turn summariser cost O(new-messages-since-last-refresh)
 * instead of O(history). Once a summary exists, the chat node marks the
 * synthetic summary turn with `cache_control: ephemeral` so Anthropic
 * caches it across turns until the next refresh.
 *
 * Failure handling — if the summariser errors, fall back to the prior
 * summary plus `keepRecent` verbatim (stale-by-one-batch). With no
 * prior summary, hard-truncate to last 20. The catastrophic
 * "send the whole transcript on failure" path is gone.
 */

/**
 * Canonical prefix written on the synthetic summary turn that the
 * compressor prepends to the agent's input. The chat node detects
 * this prefix to attach `cache_control` to the right block; nothing
 * else relies on it. Keep stable.
 */
export const CHAT_SUMMARY_PREFIX = '[Summary of earlier conversation]';

export interface ChatSummaryRecord {
  text: string;
  /** Number of leading messages from `history` baked into `text`. */
  upToMessageCount: number;
  updatedAt?: Date;
}

export interface CompressMessageHistoryOptions {
  history: { role: string; content: string }[];
  /** Existing rolling summary loaded from the chat doc, if any. */
  priorSummary?: ChatSummaryRecord | null;
  /** Question or instruction passed to the summariser; transcript appended below. */
  summarizationInstruction: string;
  /** Trace label for cost / cache dashboards. */
  llmLabel: string;
  /**
   * Scope tag for chat logger lines (e.g. `'lesson'`, `'course'`,
   * `'design'`). The compressor prepends `<scope>:compress` so all
   * lines are greppable per chat.
   */
  scope: string;
  /** Number of most-recent messages preserved verbatim. Default 4. */
  keepRecent?: number;
  /**
   * Refresh fires when the uncovered slice exceeds
   * `keepRecent + refreshThreshold`. Default 6 → uncovered
   * grows up to 10 messages before we re-summarise.
   */
  refreshThreshold?: number;
}

export interface CompressMessageHistoryResult {
  /**
   * Messages to feed the agent. When a summary applies, the first
   * entry is a synthetic assistant turn with `CHAT_SUMMARY_PREFIX`.
   * Caller appends the new user message.
   */
  history: { role: string; content: string }[];
  /**
   * When defined, caller must persist this back to the chat doc's
   * `summary` field. Undefined means "no change — keep priorSummary
   * (or no summary if priorSummary was undefined)".
   */
  newSummary?: ChatSummaryRecord;
}

const DEFAULT_KEEP_RECENT = 4;
const DEFAULT_REFRESH_THRESHOLD = 6;
const SUMMARY_TARGET_CHARS = 800;

const buildSummaryTurn = (text: string): { role: 'assistant'; content: string } => ({
  role: 'assistant',
  content: `${CHAT_SUMMARY_PREFIX}\n${text}`,
});

const renderTranscript = (messages: { role: string; content: string }[]): string =>
  messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');

const buildSummariserPrompt = ({
  instruction,
  priorSummary,
  newMessages,
}: {
  instruction: string;
  priorSummary?: ChatSummaryRecord | null;
  newMessages: { role: string; content: string }[];
}): string => {
  const transcript = renderTranscript(newMessages);
  if (priorSummary) {
    return [
      instruction,
      '',
      'Existing summary so far:',
      priorSummary.text,
      '',
      'New messages since:',
      transcript,
      '',
      `Update the summary to incorporate the new messages. Keep it under ${SUMMARY_TARGET_CHARS} characters and 5–8 bullets.`,
    ].join('\n');
  }
  return [
    instruction,
    '',
    'Conversation:',
    transcript,
    '',
    `Keep your summary under ${SUMMARY_TARGET_CHARS} characters and 5–8 bullets.`,
  ].join('\n');
};

export const compressMessageHistory = async ({
  history,
  priorSummary,
  summarizationInstruction,
  llmLabel,
  scope,
  keepRecent = DEFAULT_KEEP_RECENT,
  refreshThreshold = DEFAULT_REFRESH_THRESHOLD,
}: CompressMessageHistoryOptions): Promise<CompressMessageHistoryResult> => {
  const summarizedSoFar = Math.min(priorSummary?.upToMessageCount ?? 0, history.length);
  const recentSlice = history.slice(summarizedSoFar);
  const refreshAt = keepRecent + refreshThreshold;
  const turnsUntilRefresh = Math.max(0, refreshAt - recentSlice.length + 1);

  // Per-request state line — one place to read where we are in the
  // rolling-summary cycle. `until-refresh` is messages-not-turns: each
  // chat turn appends 2 (user + assistant), so divide by 2 if you're
  // estimating remaining turns.
  const summaryAgeMs = priorSummary?.updatedAt
    ? Date.now() - new Date(priorSummary.updatedAt).getTime()
    : null;
  const priorSummaryDesc = priorSummary
    ? `yes(upTo=${priorSummary.upToMessageCount},${priorSummary.text.length}c,age=${summaryAgeMs !== null ? `${Math.round(summaryAgeMs / 1000)}s` : 'n/a'})`
    : 'no';
  chat.info(
    `${scope}:compress state history=${history.length} priorSummary=${priorSummaryDesc} uncovered=${recentSlice.length} refresh-at=${refreshAt} until-refresh=${turnsUntilRefresh}`,
  );

  // No summary yet AND short enough → pass through unchanged.
  if (!priorSummary && recentSlice.length <= refreshAt) {
    chat.info(
      `${scope}:compress passthrough — no summary needed yet (${recentSlice.length}/${refreshAt} messages)`,
    );
    return { history };
  }

  // Have a prior summary but uncovered slice is still inside the
  // refresh window → reuse it verbatim, no LLM call.
  if (priorSummary && recentSlice.length <= refreshAt) {
    chat.info(
      `${scope}:compress reuse — ${recentSlice.length}/${refreshAt} uncovered, refresh in ${turnsUntilRefresh} message(s)`,
    );
    return {
      history: [buildSummaryTurn(priorSummary.text), ...recentSlice],
    };
  }

  // Refresh path: summarise the excess.
  const excessCount = recentSlice.length - keepRecent;
  const newToSummarise = recentSlice.slice(0, excessCount);
  const recentToKeep = recentSlice.slice(excessCount);

  chat.info(
    `${scope}:compress REFRESHING uncovered=${recentSlice.length} > ${refreshAt}, folding ${newToSummarise.length} new message(s) into ${priorSummary ? 'existing' : 'fresh'} summary, keeping last ${recentToKeep.length} verbatim`,
  );
  const refreshStartMs = Date.now();

  try {
    const model = getUtilityModel();
    const result = await model.invoke(
      [
        new HumanMessage(
          buildSummariserPrompt({
            instruction: summarizationInstruction,
            priorSummary,
            newMessages: newToSummarise,
          }),
        ),
      ],
      { metadata: { llmLabel } },
    );

    const summaryText =
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content);

    const newSummary: ChatSummaryRecord = {
      text: summaryText,
      upToMessageCount: history.length - keepRecent,
      updatedAt: new Date(),
    };

    // After refresh, uncovered = keepRecent. Next refresh fires when
    // uncovered crosses refreshAt, so it's `refreshThreshold + 1` more
    // messages away — roughly that many ÷ 2 chat turns.
    const messagesUntilNextRefresh = refreshThreshold + 1;
    const refreshMs = Date.now() - refreshStartMs;
    chat.info(
      `${scope}:compress done ms=${refreshMs} folded=${newToSummarise.length} summary=${summaryText.length}c upTo=${newSummary.upToMessageCount}/${history.length} next-refresh-in=~${messagesUntilNextRefresh} message(s) (${Math.ceil(messagesUntilNextRefresh / 2)} turn(s))`,
    );

    return {
      history: [buildSummaryTurn(summaryText), ...recentToKeep],
      newSummary,
    };
  } catch (e) {
    chat.warn(
      `${scope}:compress summariser failed ms=${Date.now() - refreshStartMs} err=${e instanceof Error ? e.message : e}`,
    );

    // Graceful fallback. With a prior summary, use it + last keepRecent
    // verbatim — stale by one batch but still well-bounded. Without one,
    // hard-truncate to a safety window so a 200-message session never
    // gets sent uncompressed.
    if (priorSummary) {
      chat.warn(
        `${scope}:compress fallback reuse-prior + last ${recentToKeep.length} verbatim (stale by ${newToSummarise.length} message(s))`,
      );
      return {
        history: [buildSummaryTurn(priorSummary.text), ...recentToKeep],
      };
    }
    const SAFETY_WINDOW = 20;
    const truncated = history.slice(-SAFETY_WINDOW);
    chat.warn(
      `${scope}:compress fallback hard-truncate to last ${truncated.length}/${history.length} message(s)`,
    );
    return { history: truncated };
  }
};
