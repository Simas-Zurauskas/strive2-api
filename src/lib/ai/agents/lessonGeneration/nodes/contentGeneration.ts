import { RunnableConfig } from '@langchain/core/runnables';
import { streamObject, NoObjectGeneratedError } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { MODEL_IDS } from '@lib/langchain';
import { logCacheUsage, usageFromVercelAi } from '@lib/ai/cacheLogger';
import type { LessonProgressWriter } from '@src/types/socketEvents';
import type { ILessonBlock } from '@models/LessonContentModel';
import { LessonState } from '../state';
import { contentOutputSchema, buildLessonSystemPrompt } from '../prompts';

// Structural floor: 1 intro + 2 sections + 1 summary = 4 blocks minimum.
// We retry once when the first pass comes back below this — such lessons
// otherwise force the contentValidation repair path, which is more expensive
// and produces tacked-on blocks rather than a cohesive rewrite.
//
// Overview lessons can legitimately ship tight (≥5); comprehensive and
// deep_dive should include the full block inventory (intro, 2+ sections,
// callouts, mermaid, summary, quizzes, exercise) which lands at ≥7. Raising
// the floor for the deeper tiers catches the 5-blocks-next-to-16-blocks
// variance observed in Sophie's Lesson [1/0] and [2/1] previously.
const minBlocksForDepth = (depth: string): number =>
  depth === 'comprehensive' || depth === 'deep_dive' ? 7 : 5;

// Summary size bounds. Enforced here (not in the Zod schema) so a truncated
// stream doesn't surface as `NoObjectGeneratedError` — we throw a targeted
// error that piggybacks on the existing runStream try/catch to trigger the
// recovery retry, and we truncate on the upper end rather than reject.
const SUMMARY_MIN_CHARS = 60;
const SUMMARY_MAX_CHARS = 800;

// When a NoObjectGeneratedError escapes streamObject/generateObject, the AI SDK
// wraps the underlying reason (ZodError, JSON parse error, truncation) in
// `.cause` and the raw model output in `.text`. Our job-runner persists only
// `error.message`, so without logging the cause here the Job record's "response
// did not match schema" is unactionable. Log the cause, the error name, and the
// tail of the raw response so next failure is diagnosable from stdout alone.
const logNoObjectDetails = (label: string, err: unknown): void => {
  if (!NoObjectGeneratedError.isInstance(err)) return;
  const cause = err.cause;
  const causeMsg = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  console.error(`[${label}] NoObjectGeneratedError cause: ${causeMsg}`.red);
  if (typeof err.text === 'string' && err.text.length > 0) {
    const tail = err.text.slice(-600);
    console.error(`[${label}] raw response tail (last 600 chars): ${tail}`.red);
  }
  if (err.usage) {
    console.error(`[${label}] usage: ${JSON.stringify(err.usage)}`.red);
  }
};

export const contentGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  const writer = config?.configurable?.writer as LessonProgressWriter | undefined;
  const MIN_BLOCKS_ACCEPTABLE = minBlocksForDepth(state.depth);

  console.log(`[contentGeneration] Starting block-by-block generation (min blocks: ${MIN_BLOCKS_ACCEPTABLE} for depth '${state.depth}')...`.cyan);

  // Tracks every id emitted across the first pass AND the (optional) retry so the
  // retry never replays a block the client has already seen and the repetition
  // guard still fires if the model loops on the same id within a single pass.
  const emittedIds = new Set<string>();

  // Run one streaming generation. When `emit` is true, send fully formed blocks
  // to the client as they arrive. When false, collect silently — used on retry
  // so the client doesn't see two waves of blocks.
  const runStream = async ({ emit }: { emit: boolean }) => {
    const result = streamObject({
      model: anthropic(MODEL_IDS.SONNET),
      schema: contentOutputSchema,
      temperature: 0.7,
      messages: [
        {
          role: 'system' as const,
          content: buildLessonSystemPrompt({ domain: state.domain }),
          // 1h TTL: a single course-generation burst fires `lesson:content`
          // once per lesson — often 15-50 calls spread across 10-45 minutes.
          // 5m ephemeral would expire mid-course and force the tail of the
          // run to re-tokenize the cached prefix at full input price. 1h
          // writes cost 2× input (vs 5m's 1.25×) but reads still cost 0.1×,
          // so break-even is ~3 reads — a course clears that on the 4th
          // lesson.
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
        },
        {
          role: 'user' as const,
          content: state.humanMessage,
        },
      ],
    });

    let cursor = 0;

    for await (const partial of result.partialObjectStream) {
      const blocks = partial.blocks ?? [];

      // Emit new COMPLETE blocks as they arrive
      // Blocks generate sequentially: blocks[0] completes before blocks[1] starts
      while (cursor < blocks.length) {
        const block = blocks[cursor];
        // Check if block has all required fields (meaning it's fully generated)
        if (block && block.id && block.type && typeof block.content === 'string' && typeof block.order === 'number') {
          if (emit) {
            // Repetition guard: Sonnet occasionally loops on structured output,
            // emitting the same block id thousands of times. Abort rather than
            // let it run to the token cap.
            if (emittedIds.has(block.id)) {
              throw new Error(`[contentGeneration] duplicate block id "${block.id}" at index ${cursor} — model entered a repetition loop`);
            }
            console.log(`[contentGeneration] → Block ${cursor}: ${block.id} (${block.type})`.gray);
            writer?.({ type: 'block', block: block as ILessonBlock });
            emittedIds.add(block.id);
          }
          cursor++;
        } else {
          break; // Block still being generated — wait for next yield
        }
      }
    }

    const finalObject = await result.object;
    // Log cache + token usage. `providerMetadata` and `usage` resolve only
    // after the stream is fully consumed (i.e. after `result.object`), so we
    // await them here. Wrapped in try/catch because logging must never fail
    // a lesson generation — the streamObject result is already what we care
    // about.
    try {
      const [providerMetadata, usage] = await Promise.all([result.providerMetadata, result.usage]);
      logCacheUsage({
        label: 'lesson:content',
        usage: usageFromVercelAi({ providerMetadata, usage }),
        model: MODEL_IDS.SONNET,
      });
    } catch (e) {
      console.warn(`[contentGeneration] cache-usage logging failed: ${e instanceof Error ? e.message : e}`.yellow);
    }
    return finalObject;
  };

  // First-pass failure modes that we can recover from via retry:
  //   • repetition-loop throw from the duplicate-id guard above
  //   • short-summary throw from the post-stream check below (a truncated
  //     stream or placeholder summary that won't serve downstream consumers)
  //   • mid-stream network / model errors
  // If we don't wrap, any of these fails the entire lesson-generation job —
  // exactly what killed Carlos's run (duplicate block id "section-1"). The
  // retry path already handles client-side de-dup via emittedIds, so falling
  // through here is strictly safer than propagating.
  let firstPass: Awaited<ReturnType<typeof runStream>>;
  try {
    firstPass = await runStream({ emit: true });
    // Summary is the lesson's condensed context feed for quiz-generation and
    // other downstream nodes; shipping an empty or placeholder summary
    // silently degrades those paths. A throw here hits the retry below.
    if (firstPass.summary.trim().length < SUMMARY_MIN_CHARS) {
      throw new Error(`[contentGeneration] summary too short (${firstPass.summary.trim().length} chars) — model likely truncated`);
    }
    console.log(`[contentGeneration] ✓ Complete: ${firstPass.blocks.length} blocks`.green);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[contentGeneration] ⚠ First pass failed: ${msg} — retrying without streaming`.yellow);
    logNoObjectDetails('contentGeneration.pass1', e);
    try {
      const retry = await runStream({ emit: false });
      console.log(`[contentGeneration] ✓ Recovery retry produced ${retry.blocks.length} blocks`.green);
      // Emit any retry blocks the client hasn't already seen (partial
      // pass-1 stream may have fired some `block` events before the throw).
      for (const block of retry.blocks) {
        if (!emittedIds.has(block.id)) {
          console.log(`[contentGeneration] → Block (recovery): ${block.id} (${block.type})`.gray);
          writer?.({ type: 'block', block: block as ILessonBlock });
          emittedIds.add(block.id);
        }
      }
      firstPass = retry;
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      console.error(`[contentGeneration] ✗ Recovery retry also failed: ${retryMsg}`.red);
      logNoObjectDetails('contentGeneration.retry', retryErr);
      throw retryErr;
    }
  }

  let final = firstPass;

  if (firstPass.blocks.length < MIN_BLOCKS_ACCEPTABLE) {
    console.warn(`[contentGeneration] ⚠ Only ${firstPass.blocks.length} blocks (threshold: ${MIN_BLOCKS_ACCEPTABLE}) — retrying once without streaming`.yellow);
    try {
      const retry = await runStream({ emit: false });
      console.log(`[contentGeneration] ✓ Retry produced ${retry.blocks.length} blocks`.green);

      if (retry.blocks.length > firstPass.blocks.length) {
        // Use the retry as the canonical output. Emit only blocks whose ids
        // weren't already streamed on the first pass so the client gets the
        // new content without duplicate `block` events.
        for (const block of retry.blocks) {
          if (!emittedIds.has(block.id)) {
            console.log(`[contentGeneration] → Block (retry): ${block.id} (${block.type})`.gray);
            writer?.({ type: 'block', block: block as ILessonBlock });
            emittedIds.add(block.id);
          }
        }
        final = retry;
      }
    } catch (e) {
      console.warn(`[contentGeneration] ⚠ Retry failed: ${e instanceof Error ? e.message : e}`.yellow);
      logNoObjectDetails('contentGeneration.thinBlocksRetry', e);
    }
  }

  // Graceful upper-bound: if the model overshoots the target length, truncate
  // rather than reject. Runaway prose hurts layout but not correctness; a
  // truncated-with-ellipsis summary is strictly better than a failed lesson.
  const trimmed = final.summary.trim();
  const boundedSummary = trimmed.length > SUMMARY_MAX_CHARS
    ? `${trimmed.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : trimmed;

  return {
    contentBlocks: final.blocks,
    contentSummary: boundedSummary,
  };
};
