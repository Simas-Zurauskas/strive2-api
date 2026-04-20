import { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getUtilityModel } from '@lib/langchain';
import { withRetry } from '@lib/retry';
import { jsonish } from '@lib/zodHelpers';
import { INSIGHT_KINDS, INSIGHT_MAX_PER_LESSON, INSIGHT_MIN_PER_LESSON } from '@lib/insightConstants';
import { GeneratedInsight } from '@services/insightContentService';
import { LessonState } from '../state';

// ── Schema & prompt ────────────────────────────────────

const insightCandidateSchema = z.object({
  sourceBlockId: z.string().describe("The id of the block this insight is derived from (e.g. 'section-1')"),
  kind: z.enum(INSIGHT_KINDS).describe("'qa' for a question+answer card, 'cloze' for a sentence with one {{blank}}"),
  prompt: z.string().min(5).describe('For qa: the question text (target ≤ 400 chars). For cloze: the sentence with exactly one {{blank}} placeholder.'),
  answer: z.string().min(1).describe('For qa: a terse answer (5-15 words ideal, target ≤ 200 chars). For cloze: the word or short phrase that fills the blank.'),
  conceptTags: z.array(z.string()).min(1).describe('1-4 short lowercase tags representing the concepts covered (e.g. ["spaced-repetition", "memory"])'),
});

const insightsOutputSchema = z.object({
  insights: jsonish(z.array(insightCandidateSchema).min(0)),
});

const INSIGHT_SYSTEM_PROMPT = `You extract atomic retrieval-ready "insight cards" from a lesson a learner has just read.

## What an insight card is

An insight card is a single retrieval-practice item — a question (or cloze sentence) that the learner attempts to recall before seeing the answer. Cards are later shown in a spaced-repetition feed.

## Output types

1. **qa** — a specific question with a short answer.
2. **cloze** — a 1-2 sentence claim with exactly ONE blank, marked with the literal token {{blank}}. The answer field is the word or short phrase that fills the blank.

## Hard rules

- **Atomic.** Exactly one idea per card. No compound questions.
- **Grounded.** The claim must be verifiable from the lesson content. Never introduce facts not in the source.
- **Paraphrased.** Do NOT copy lesson wording verbatim. Rephrase so that a learner who read the lesson must genuinely retrieve the answer from memory rather than pattern-match.
- **Specific over general.** "Why does X outperform Y on Z?" beats "What is X?".
- **Short.** Answers ideally 5-15 words. Cloze blanks target a single domain-specific noun or short phrase — never generic connectives like "the" or "and".
- **Distinct.** Each card must test a different concept. Do not restate the same point with different wording.
- **Skip filler.** If a lesson section is a setup paragraph or a code example without a testable claim, do not generate a card for it.

## Quality examples

Good qa card:
{ "kind": "qa", "prompt": "Why does SM-2 suffer from 'ease hell' after many Hard ratings?", "answer": "Repeated Hard presses drive the ease factor to its 1.3 floor, after which intervals barely grow." }

Good cloze card:
{ "kind": "cloze", "prompt": "FSRS models memory with three variables: Difficulty, {{blank}}, and Retrievability.", "answer": "Stability" }

Bad (copies lesson verbatim, no retrieval needed):
{ "kind": "qa", "prompt": "What is spaced repetition?", "answer": "A technique where review intervals grow over time." }

Bad (compound — two ideas):
{ "kind": "qa", "prompt": "What is the testing effect and how does it compare to rereading?", "answer": "..." }

## Count

Generate between ${INSIGHT_MIN_PER_LESSON} and ${INSIGHT_MAX_PER_LESSON} high-quality cards. If the lesson doesn't contain enough testable claims for ${INSIGHT_MIN_PER_LESSON}, return only what is genuinely card-worthy — do not pad.

## conceptTags

Each card should have 1-3 short lowercase tags (kebab-case) naming the concepts covered. These drive cross-course interleaving later.`;

// ── Helpers ───────────────────────────────────────────

const formatLessonForExtraction = (state: LessonState): string => {
  // Focus on teaching content. Skip interactive, image, and link blocks —
  // they don't have testable claims.
  const teachable = state.contentBlocks.filter((b) =>
    ['intro', 'section', 'callout', 'summary'].includes(b.type),
  );

  return teachable
    .map((b) => `[id=${b.id}] [${b.type}]\n${b.content}`)
    .join('\n\n---\n\n');
};

/** Post-filter candidates to guard against weak or duplicate items. */
const filterCandidates = (
  candidates: z.infer<typeof insightCandidateSchema>[],
): GeneratedInsight[] => {
  const out: GeneratedInsight[] = [];
  const seenAnswers = new Set<string>();

  for (const c of candidates) {
    const promptTrim = c.prompt.trim();
    const answerTrim = c.answer.trim();

    // Structural checks
    if (!promptTrim || !answerTrim) continue;
    if (promptTrim.length < 10) continue;

    // Cloze must have a {{blank}}
    if (c.kind === 'cloze' && !/\{\{\s*blank\s*\}\}/i.test(promptTrim)) continue;

    // Single-word / trivial answer in qa mode is suspicious; allow short
    // cloze answers but reject qa answers that are likely too recognizable.
    if (c.kind === 'qa' && /^(yes|no|true|false)$/i.test(answerTrim)) continue;

    // Dedup by lowercased answer + kind
    const key = `${c.kind}|${answerTrim.toLowerCase()}`;
    if (seenAnswers.has(key)) continue;
    seenAnswers.add(key);

    out.push({
      kind: c.kind,
      prompt: promptTrim,
      answer: answerTrim,
      conceptTags: c.conceptTags,
      sourceBlockId: c.sourceBlockId,
    });
  }

  return out.slice(0, INSIGHT_MAX_PER_LESSON);
};

// ── Node ──────────────────────────────────────────────

export const insightGeneration = async (
  state: LessonState,
  config?: RunnableConfig,
): Promise<Partial<LessonState>> => {
  const writer = config?.configurable?.writer as
    | ((event: Record<string, unknown>) => void)
    | undefined;

  // Guard: nothing to do if no teachable content.
  const teachable = state.contentBlocks.filter((b) =>
    ['intro', 'section', 'callout', 'summary'].includes(b.type),
  );
  if (teachable.length === 0) {
    console.log(`[insightGeneration] Skipped — no teachable blocks`.gray);
    return { insights: [] };
  }

  const humanMessage = `## Lesson

Title: ${state.lessonName}
Module: ${state.moduleName}
Description: ${state.lessonDescription}

## Source blocks

Use the [id=...] tag to set \`sourceBlockId\` so each card is traceable to the block it came from.

${formatLessonForExtraction(state)}

Return ${INSIGHT_MIN_PER_LESSON}-${INSIGHT_MAX_PER_LESSON} insight cards covering the most important ideas. Prefer questions over clozes unless a cloze is clearly the better shape for the claim.`;

  try {
    console.log(`[insightGeneration] Extracting insights...`.cyan);

    const model = getUtilityModel().withStructuredOutput(insightsOutputSchema);
    const result = await withRetry(() =>
      model.invoke([
        new SystemMessage(INSIGHT_SYSTEM_PROMPT),
        new HumanMessage(humanMessage),
      ]),
    );

    const filtered = filterCandidates(result.insights ?? []);

    // Fire one SSE event per insight (client can render a side-panel live
    // preview later; for now we just keep parity with other node events).
    for (const ins of filtered) {
      writer?.({ type: 'insight', insight: ins });
    }

    console.log(
      `[insightGeneration] ✓ ${filtered.length} insights (${result.insights.length} candidates)`.green,
    );
    return { insights: filtered };
  } catch (e) {
    // Extraction failures never block the lesson. Research philosophy:
    // insights are additive enrichment.
    console.warn(`[insightGeneration] ✗ Failed: ${e instanceof Error ? e.message : e}`.yellow);
    return { insights: [] };
  }
};
