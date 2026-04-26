import { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getUtilityModel } from '@lib/langchain';
import { withRetry } from '@lib/retry';
import { jsonish } from '@lib/zodHelpers';
import { INSIGHT_KINDS, INSIGHT_MAX_PER_LESSON, INSIGHT_MIN_PER_LESSON } from '@lib/insightConstants';
import { GeneratedInsight } from '@services/insightContentService';
import type { LessonProgressWriter } from '@src/types/socketEvents';
import { LessonState } from '../state';
import { validateInsightCandidate } from './insightGuardrails';

// ── Schema & prompt ────────────────────────────────────

const insightCandidateSchema = z.object({
  sourceBlockId: z.string().describe("The id of the block this insight is derived from (e.g. 'section-1')"),
  kind: z.enum(INSIGHT_KINDS).describe("'qa' for a question+answer card, 'cloze' for a sentence with one {{blank}}"),
  prompt: z.string().min(5).describe('For qa: the question text (target ≤ 400 chars). For cloze: the sentence with exactly one {{blank}} placeholder.'),
  answer: z.string().min(1).describe('For qa: a terse answer (5-15 words ideal, target ≤ 200 chars). For cloze: the word or short phrase that fills the blank.'),
  conceptTags: z.array(z.string()).optional().default([]).describe('1-4 short lowercase tags representing the concepts covered (e.g. ["spaced-repetition", "memory"]). REQUIRED on every card — omit only if no meaningful tag applies.'),
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
- **Paraphrased stem.** The stem (the question or cloze sentence framing the blank) must rephrase lesson wording so the learner genuinely retrieves the answer from memory rather than pattern-matches. Do NOT copy a whole lesson sentence into the stem.
- **Canonical grounded in lesson wording.** The answer (QA answer or cloze deletion target) must be a term or phrase that appears in the source lesson — verbatim, or as a trivial inflection (case, plural, tense). Do NOT synthesize your own terminology when the lesson already has a term for the concept. If the lesson uses "harmonic rhythm" for a concept, the canonical is "harmonic rhythm" — not "harmonic turbulence." If no single lesson-supported term cleanly fits a cloze deletion, switch the card to a **qa** and let the answer paraphrase while using lesson-rooted keywords for the core concepts. Grading fairness depends on this: the typed-recall grader has no access to the lesson and can only compare the canonical to the learner's answer.
- **Specific over general.** "Why does X outperform Y on Z?" beats "What is X?".
- **Short.** Answers ideally 5-15 words. Cloze blanks target a single domain-specific noun or short phrase — never generic connectives like "the" or "and".
- **Distinct.** Each card must test a different concept. Do not restate the same point with different wording.
- **Skip filler.** If a lesson section is a setup paragraph or a code example without a testable claim, do not generate a card for it.
- **Cloze answer discipline.** The word/phrase that fills {{blank}} must be a SINGLE atomic term:
  - 1-3 words maximum (3 only for multi-word technical terms like "red-black tree", "stochastic gradient descent", "XOR mutability").
  - No disjunctions: NEVER " or ", " / ", "X | Y", parentheses around alternatives ("(X or Y)"), or comma-separated lists.
  - No code expressions: NEVER a function call (\`foo.bar()\`), a chained method (\`x.strip("_")\`), or an operator expression. If the concept is a code pattern, make it a **qa** card instead.
  - No quotes and no backticks. Hyphens, CamelCase, and inline LaTeX (\`$\\Delta G$\`) are allowed.
  - The stem must give enough context that exactly ONE canonical answer fits. If a reader could plausibly answer {{blank}} with two different single-token nouns ("props", "interface", "shape" all fitting a React context), the card is too ambiguous — rewrite the stem or drop the card.
- **Cloze single-blank rule.** Exactly ONE {{blank}} per cloze. Never two blanks in one sentence — "{{blank}} and {{blank}} are marker traits" is forbidden; make two cards, one per concept.
- **QA answer discipline.** QA answers ≤ 15 words. If the answer contains " and " linking two distinct named concepts (e.g., "Send and Sync"), SPLIT into two cards — one per concept.

## Quality examples

Good qa card:
{ "kind": "qa", "prompt": "Why does SM-2 suffer from 'ease hell' after many Hard ratings?", "answer": "Repeated Hard presses drive the ease factor to its 1.3 floor, after which intervals barely grow.", "conceptTags": ["sm-2", "ease-factor"] }

Good cloze card:
{ "kind": "cloze", "prompt": "FSRS models memory with three variables: Difficulty, {{blank}}, and Retrievability.", "answer": "Stability", "conceptTags": ["fsrs", "memory-model"] }

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
  candidates: z.input<typeof insightCandidateSchema>[],
): GeneratedInsight[] => {
  const out: GeneratedInsight[] = [];
  const seenAnswers = new Set<string>();

  for (const c of candidates) {
    const promptTrim = c.prompt.trim();
    const answerTrim = c.answer.trim();

    // Structural checks
    if (!promptTrim || !answerTrim) continue;
    if (promptTrim.length < 10) continue;

    // Content-quality validator. Runs BEFORE dedupe so rejected candidates
    // don't pollute the answer-map key space.
    const validation = validateInsightCandidate(c);
    if (!validation.valid) {
      console.log(`[insightGeneration] drop candidate (${validation.reason})`.gray);
      continue;
    }

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
      conceptTags: c.conceptTags ?? [],
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
  const writer = config?.configurable?.writer as LessonProgressWriter | undefined;

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
      model.invoke(
        [new SystemMessage(INSIGHT_SYSTEM_PROMPT), new HumanMessage(humanMessage)],
        { metadata: { llmLabel: 'lesson:insights' } },
      ),
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
