import { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getInteractiveModel, getUtilityModel } from '@lib/langchain';
import { cachedSystemMessage } from '@lib/ai/cacheControl';
import { sanitizeLatex } from '@lib/latexSanitizer';
import { sanitizeArtifacts } from '@lib/artifactSanitizer';
import {
  bumpArtifactScrubStrips,
  bumpArtifactScrubGutted,
  bumpQuizDistractorLintRetry,
  bumpQuizDistractorLintHardFail,
  bumpQuizDistractorLintRepaired,
  bumpQuizDistractorLintLengthOnlyShipped,
  bumpInteractiveHaikuAttempt,
  bumpInteractiveSonnetEscalation,
} from '@lib/metrics';
import { withRetry } from '@lib/retry';
import { shuffleOptionsWithCorrectIndex } from '@lib/ai/shuffleOptions';
import { lintDistractors, repairDistractors } from '@lib/ai/distractorLint';
import type { LessonProgressWriter } from '@src/types/socketEvents';
import { LessonState } from '../state';
import { interactiveOutputSchema, buildInteractiveSystemPrompt } from '../prompts';

// One retry max (2 total attempts). Production logs showed attempt 3 was
// usually the same failure flavor as attempt 2 — diminishing returns. With
// the prompt reframing (distractors longer than correct) and the worked
// contrast example below, first-try pass rate should rise; residual
// violations still flow into mechanical repair before shipping.
const MAX_DISTRACTOR_LINT_ATTEMPTS = 2;

/**
 * Shown to the learner when an inline quiz's `explanation` field was
 * almost entirely AI self-correction meta-phrases (gutted >60%). The
 * original content is gone but the option + quiz item still render;
 * this placeholder preserves the block rather than shipping an empty
 * explanation string that the client would render as whitespace.
 */
const GUTTED_EXPLANATION_FALLBACK = 'See the section above for details.';

/**
 * Shuffle inline-quiz MCQ options at generation time so the correct answer
 * lands in a random position. The module-quiz generation path does the same
 * via `shuffleQuizOptions`; without this step the lesson-level inline
 * quizzes inherit the LLM's positional bias and "always pick B" strategies
 * score well above chance (observed 8/12 at position 1 in prior assessments).
 *
 * Skips blocks that aren't MCQ-shaped (missing/malformed metadata).
 */
const shuffleQuizBlockOptions = (block: LessonState['interactiveBlocks'][number]): LessonState['interactiveBlocks'][number] => {
  if (block.type !== 'quiz' || !block.metadata || typeof block.metadata !== 'object') return block;
  const meta = block.metadata as Record<string, unknown>;
  const options = meta.options;
  const correctIndex = meta.correctIndex;
  if (!Array.isArray(options) || options.length < 2) return block;
  if (typeof correctIndex !== 'number' || correctIndex < 0 || correctIndex >= options.length) return block;
  if (!options.every((o) => typeof o === 'string')) return block;

  const shuffled = shuffleOptionsWithCorrectIndex({
    options: options as string[],
    correctIndex,
  });

  return {
    ...block,
    metadata: {
      ...meta,
      options: shuffled.options,
      correctIndex: shuffled.correctIndex,
    },
  };
};

// Sanitize LaTeX AND AI-self-correction artifacts in an interactive block's
// markdown-bearing fields. Order matters: run LaTeX first (validates `$…$`
// math spans), then artifacts (strips meta-phrases like "Re-selecting
// correctIndex to 2"). The artifact sanitizer uses no `$`-bounded patterns
// so it can't damage the math spans the LaTeX pass just validated.
//
// Returns the block with any failing spans replaced, plus counts for both
// failure modes so the caller can warn independently.
const sanitizeInteractiveBlock = (block: LessonState['interactiveBlocks'][number]) => {
  let failedSpans = 0;
  let artifactStrips = 0;
  let artifactGutted = 0;
  const out = { ...block };

  const scrubField = (value: string, opts: { fallbackOnGut?: string } = {}): string => {
    const latexRes = sanitizeLatex(value);
    if (latexRes.failedSpans > 0) failedSpans += latexRes.failedSpans;
    const artifactRes = sanitizeArtifacts(latexRes.text);
    if (artifactRes.stripped > 0) artifactStrips += artifactRes.stripped;
    if (artifactRes.gutted) {
      artifactGutted += 1;
      if (opts.fallbackOnGut !== undefined) return opts.fallbackOnGut;
    }
    return artifactRes.text;
  };

  if (typeof out.content === 'string' && out.content.length > 0) {
    out.content = scrubField(out.content);
  }

  if (out.type === 'quiz' && out.metadata && typeof out.metadata === 'object') {
    const meta: Record<string, unknown> = { ...out.metadata };
    if (typeof meta.question === 'string') {
      meta.question = scrubField(meta.question as string);
    }
    if (typeof meta.explanation === 'string') {
      meta.explanation = scrubField(meta.explanation as string, { fallbackOnGut: GUTTED_EXPLANATION_FALLBACK });
    }
    if (Array.isArray(meta.options)) {
      meta.options = (meta.options as unknown[]).map((opt) => {
        if (typeof opt !== 'string') return opt;
        return scrubField(opt);
      });
    }
    out.metadata = meta;
  }

  return { block: out, failedSpans, artifactStrips, artifactGutted };
};

const formatBlocksForContext = (blocks: LessonState['contentBlocks']) => {
  return blocks
    .map((b) => `[order=${b.order}] [${b.type}] ${b.content}`)
    .join('\n\n');
};

type QuizLintViolation = { id: string; reasons: string[] };

// `length-uniformity` is treated as low-signal on its own: the skim-gaming
// defense (pick-the-longest) is already covered by `correct-not-longest`.
// When it's the ONLY residual reason on a block we ship the block and bump
// a separate metric rather than burning an LLM retry. Stripping it from
// feedback also stops the seesaw where the model shortens the correct
// answer to satisfy `correct-is-longest`, then falls below the length band
// and re-triggers the lint.
const LENGTH_ONLY_REASON = 'length-uniformity';

const actionableReasonsOf = (violation: QuizLintViolation): string[] =>
  violation.reasons.filter((r) => r !== LENGTH_ONLY_REASON);

const isActionableViolation = (violation: QuizLintViolation): boolean =>
  actionableReasonsOf(violation).length > 0;

// Runs distractor-lint on every MCQ-shaped block. Pre-sanitize, pre-shuffle:
// `correctIndex` still reflects generation order (required by length /
// longest checks).
const lintQuizBlocks = (blocks: z.infer<typeof interactiveOutputSchema>['blocks']): QuizLintViolation[] => {
  const out: QuizLintViolation[] = [];
  for (const block of blocks) {
    if (block.type !== 'quiz' || !block.metadata || typeof block.metadata !== 'object') continue;
    const meta = block.metadata as Record<string, unknown>;
    const options = meta.options;
    const correctIndex = meta.correctIndex;
    if (!Array.isArray(options) || !options.every((o) => typeof o === 'string')) continue;
    if (typeof correctIndex !== 'number') continue;
    const lint = lintDistractors({ options: options as string[], correctIndex });
    if (lint.reasons.length > 0) out.push({ id: block.id, reasons: lint.reasons });
  }
  return out;
};

// Final-attempt mechanical repair pass. For every block still violating
// after the LLM-retry loop, try `repairDistractors`; if the repair clears
// all lint reasons, commit the new options to `block.metadata` and count
// it as repaired. Partial repairs (helped but didn't fully clear) are
// also committed — a reduced tell still beats shipping the full one —
// and the residual reasons are returned so the caller can still log a
// hard-fail for the leftover.
const repairQuizBlocks = ({
  blocks,
  violations,
}: {
  blocks: z.infer<typeof interactiveOutputSchema>['blocks'];
  violations: QuizLintViolation[];
}): { residual: QuizLintViolation[]; repairedIds: string[] } => {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const repairedIds: string[] = [];
  const residual: QuizLintViolation[] = [];

  for (const v of violations) {
    const block = byId.get(v.id);
    if (!block || block.type !== 'quiz' || !block.metadata || typeof block.metadata !== 'object') {
      residual.push(v);
      continue;
    }
    const meta = block.metadata as Record<string, unknown>;
    const options = meta.options;
    const correctIndex = meta.correctIndex;
    if (!Array.isArray(options) || !options.every((o) => typeof o === 'string') || typeof correctIndex !== 'number') {
      residual.push(v);
      continue;
    }

    const repair = repairDistractors({ options: options as string[], correctIndex });
    if (!repair.changed) {
      residual.push(v);
      continue;
    }

    meta.options = repair.options;
    block.metadata = meta;

    const postLint = lintDistractors({ options: repair.options, correctIndex });
    if (postLint.reasons.length === 0) {
      repairedIds.push(v.id);
    } else {
      residual.push({ id: v.id, reasons: postLint.reasons });
    }
  }

  return { residual, repairedIds };
};

const LINT_REASON_HINT: Record<string, string> = {
  'length-uniformity': 'all four options must be within ±35% of the median character length — move the short/long outliers toward the median, preferably by lengthening short distractors with plausible elaboration rather than shortening the correct answer',
  'correct-is-longest': 'the correct answer cannot be strictly the longest option — tighten it or lengthen the distractors so at least one ties or exceeds it',
  'distractor-absolute-qualifier': 'distractors contain "always / never / only / all / none / every / any" while the correct answer does not — strip those absolute qualifiers from distractors (or add one to the correct answer)',
};

// Build a targeted retry message for the LLM. Names each offending block,
// lists its violations with concrete guidance, and restates the rules. We
// echo the offending options verbatim so the model can see what it produced
// without needing to look it up.
const buildDistractorLintFeedback = ({
  blocks,
  violations,
}: {
  blocks: z.infer<typeof interactiveOutputSchema>['blocks'];
  violations: QuizLintViolation[];
}): HumanMessage => {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const perBlock = violations
    .map((v) => {
      const block = byId.get(v.id);
      const meta = (block?.metadata ?? {}) as Record<string, unknown>;
      const options = Array.isArray(meta.options) ? (meta.options as unknown[]).map((o, i) => `    ${i}: ${typeof o === 'string' ? o : JSON.stringify(o)}`).join('\n') : '    (options unavailable)';
      const correctIndex = typeof meta.correctIndex === 'number' ? meta.correctIndex : -1;
      const reasons = v.reasons.map((r) => `  - ${r}: ${LINT_REASON_HINT[r] ?? ''}`).join('\n');
      return `Block "${v.id}" (correctIndex=${correctIndex}):\n${options}\n${reasons}`;
    })
    .join('\n\n');

  return new HumanMessage(
    `The previous response violated distractor-quality rules on ${violations.length} quiz block(s). Regenerate the WHOLE interactive set (same quiz topics, same exercise), fixing the violations below. Keep correct answers semantically the same — only rewrite OPTION phrasing / length so the lint passes.\n\n${perBlock}\n\nReminder of the rules:\n- Length discipline: lengthen distractors with plausible elaboration, keep the correct answer tighter. All four within ±35% of the median length; correct answer NOT the strictly longest.\n- No absolute qualifiers in distractors unless the correct answer also uses one.\n- Surface-intuition trap: at least one distractor shares surface features with the correct answer.`,
  );
};

export const interactiveGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  const writer = config?.configurable?.writer as LessonProgressWriter | undefined;

  console.log(`[interactiveGeneration] Generating quizzes + exercise...`.cyan);

  const summaryBlock = state.contentBlocks.find((b) => b.type === 'summary');
  const maxContentOrder = Math.max(...state.contentBlocks.map((b) => b.order));

  const codeLanguages = [...new Set(
    state.contentBlocks
      .filter((b) => b.type === 'code' && b.metadata?.language)
      .map((b) => b.metadata!.language as string),
  )];

  const humanMessage = `## Lesson content

${formatBlocksForContext(state.contentBlocks)}

## Lesson info

Title: ${state.lessonName}
Description: ${state.lessonDescription}
Course depth: ${state.depth}${state.domain ? `\nCourse domain: ${state.domain}` : ''}${codeLanguages.length > 0 ? `\nCode appearing in lesson body (for illustration only — this does NOT dictate the exercise format): ${codeLanguages.join(', ')}` : ''}

## Positioning instructions

The content blocks use order values 0 through ${maxContentOrder}.
- Place quiz blocks by inserting them between existing content blocks. Use decimal orders to insert between integers (e.g., 2.5 to place between order 2 and 3). Pick positions AFTER the section that teaches the concept being tested.
- Place the exercise block at order ${summaryBlock ? summaryBlock.order - 0.5 : maxContentOrder + 1} (just before the summary).

Generate 1-2 quiz blocks and 1 exercise block.`;

  try {
    // Model-tier escalation. Attempt 1 uses Haiku (5× cheaper per token);
    // attempt 2 (and any further retry from distractor-lint) uses Sonnet.
    // Escalation fires on:
    //   (a) Haiku throwing from withRetry (schema / count-floor failure)
    //   (b) Haiku succeeding but leaving residual actionable distractor-
    //       lint violations that the deterministic repair pass couldn't
    //       clear.
    // Rationale: inline-quiz structured output is mostly schema-filling that
    // Haiku handles, but the "distractor must share surface feature with
    // correct answer but be wrong for a named reason" rule is nuanced prose.
    // We bet that Haiku clears most lessons outright, and Sonnet only fires
    // on the residual tail.
    const haikuModel = getUtilityModel().withStructuredOutput(interactiveOutputSchema);
    const sonnetModel = getInteractiveModel().withStructuredOutput(interactiveOutputSchema);

    // Lint-retry loop (2026-04-21 follow-up). Re-invoke with targeted
    // violation feedback on distractor-lint fail, capped at MAX attempts.
    // Final attempt ships even if still violating — shipping a flagged
    // quiz beats shipping an empty interactive section.
    let result: z.infer<typeof interactiveOutputSchema> | undefined;
    let quizLintViolations: Array<{ id: string; reasons: string[] }> = [];
    let lintFeedback: HumanMessage | null = null;
    let attempt = 0;
    while (attempt < MAX_DISTRACTOR_LINT_ATTEMPTS) {
      attempt += 1;
      const tier: 'haiku' | 'sonnet' = attempt === 1 ? 'haiku' : 'sonnet';
      const activeModel = tier === 'haiku' ? haikuModel : sonnetModel;
      const label = tier === 'haiku' ? 'lesson:interactive.haiku' : 'lesson:interactive.sonnet';

      if (tier === 'haiku') bumpInteractiveHaikuAttempt();
      else bumpInteractiveSonnetEscalation();

      const messages = [cachedSystemMessage({ text: buildInteractiveSystemPrompt({ domain: state.domain }), ttl: '1h' }), new HumanMessage(humanMessage)];
      if (lintFeedback) messages.push(lintFeedback);

      // Count-floor retry stays inside withRetry (its backoff handles
      // transient model failures). Distractor-lint retry lives here and
      // re-prompts with explicit feedback.
      let attemptOutput: z.infer<typeof interactiveOutputSchema>;
      try {
        attemptOutput = await withRetry(async () => {
          const output = await activeModel.invoke(messages, { metadata: { llmLabel: label } }) as z.infer<typeof interactiveOutputSchema>;
          const quizCount = output.blocks.filter((b) => b.type === 'quiz').length;
          const exerciseCount = output.blocks.filter((b) => b.type === 'exercise').length;
          if (quizCount < 1 || exerciseCount < 1) {
            throw new Error(`interactive count below floor: ${quizCount} quiz(zes), ${exerciseCount} exercise(s) — need ≥1 of each`);
          }
          return output;
        });
      } catch (err) {
        // Haiku hit a schema / count-floor failure that withRetry couldn't
        // recover from. Escalate to Sonnet if we still have attempts left.
        // Reset `lintFeedback` because its question-id references won't
        // apply to a fresh Sonnet generation.
        if (tier === 'haiku' && attempt < MAX_DISTRACTOR_LINT_ATTEMPTS) {
          console.warn(`[interactiveGeneration] ⚠ Haiku attempt failed (${err instanceof Error ? err.message : err}) — escalating to Sonnet`.yellow);
          lintFeedback = null;
          continue;
        }
        throw err;
      }

      quizLintViolations = lintQuizBlocks(attemptOutput.blocks);
      result = attemptOutput;

      if (quizLintViolations.length === 0) break;

      // Split each violation into actionable reasons (everything except
      // length-uniformity) and a length-only flag. A block retries only
      // when it has at least one actionable reason.
      const actionableViolations: QuizLintViolation[] = quizLintViolations
        .filter(isActionableViolation)
        .map((v) => ({ id: v.id, reasons: actionableReasonsOf(v) }));
      const lengthOnlyIds = quizLintViolations
        .filter((v) => !isActionableViolation(v))
        .map((v) => v.id);

      if (actionableViolations.length === 0) {
        for (let i = 0; i < lengthOnlyIds.length; i++) bumpQuizDistractorLintLengthOnlyShipped();
        console.log(`[interactiveGeneration] ℹ distractor-lint length-uniformity only on ${lengthOnlyIds.length} block(s) — shipping (correct-not-longest guard holds): ${lengthOnlyIds.join(', ')}`.gray);
        break;
      }

      // Repair-first: run mechanical repair (hedge absolute qualifiers, trim
      // correct-answer tail) on every attempt where actionable violations
      // appear, not only on the final attempt. ~60-70% of common violations
      // (absolute-qualifier, correct-is-longest) clear here deterministically,
      // saving a full Sonnet retry call. Mutates `attemptOutput.blocks` in
      // place. See `repairDistractors` in distractorLint.ts for scope.
      const repair = repairQuizBlocks({ blocks: attemptOutput.blocks, violations: actionableViolations });
      if (repair.repairedIds.length > 0) {
        for (let i = 0; i < repair.repairedIds.length; i++) bumpQuizDistractorLintRepaired();
        console.log(`[interactiveGeneration] ✓ distractor-lint repair cleared ${repair.repairedIds.length} block(s): ${repair.repairedIds.join(', ')}`.green);
      }

      const residualActionable = repair.residual.filter(isActionableViolation);
      const residualLengthOnlyIds = [
        ...lengthOnlyIds,
        ...repair.residual.filter((v) => !isActionableViolation(v)).map((v) => v.id),
      ];

      if (residualActionable.length === 0) {
        // Repair cleared every actionable reason — ship without a retry.
        if (residualLengthOnlyIds.length > 0) {
          for (let i = 0; i < residualLengthOnlyIds.length; i++) bumpQuizDistractorLintLengthOnlyShipped();
          console.log(`[interactiveGeneration] ℹ distractor-lint length-uniformity only on ${residualLengthOnlyIds.length} block(s) — shipping: ${residualLengthOnlyIds.join(', ')}`.gray);
        }
        break;
      }

      const residualSummary = residualActionable
        .map((v) => `${v.id}=[${actionableReasonsOf(v).join(',')}]`)
        .join(' ');

      if (attempt === MAX_DISTRACTOR_LINT_ATTEMPTS) {
        // Out of attempts. Ship with hard-fail log.
        bumpQuizDistractorLintHardFail();
        console.warn(`[interactiveGeneration] ⚠ distractor-lint hard-fail after ${MAX_DISTRACTOR_LINT_ATTEMPTS} attempts + repair on ${residualActionable.length} block(s) — shipping anyway: ${residualSummary}`.yellow);
        if (residualLengthOnlyIds.length > 0) {
          for (let i = 0; i < residualLengthOnlyIds.length; i++) bumpQuizDistractorLintLengthOnlyShipped();
          console.log(`[interactiveGeneration] ℹ distractor-lint length-uniformity only on ${residualLengthOnlyIds.length} block(s) — shipping: ${residualLengthOnlyIds.join(', ')}`.gray);
        }
        break;
      }

      bumpQuizDistractorLintRetry();
      console.warn(`[interactiveGeneration] ⚠ distractor-lint attempt ${attempt}/${MAX_DISTRACTOR_LINT_ATTEMPTS} after repair — ${residualSummary}; retrying with feedback`.yellow);
      lintFeedback = buildDistractorLintFeedback({ blocks: attemptOutput.blocks, violations: residualActionable });
    }

    if (!result) throw new Error('interactive generation produced no result');

    // Sanitize LaTeX + AI-self-correction artifacts in every interactive
    // block before emitting to the client.
    let totalLatexFailures = 0;
    let totalArtifactStrips = 0;
    let totalArtifactGutted = 0;
    const sanitizedBlocks = result.blocks.map((b) => {
      const { block, failedSpans, artifactStrips, artifactGutted } = sanitizeInteractiveBlock(b);
      if (failedSpans > 0) {
        console.warn(`[interactiveGeneration] LaTeX sanitize: ${block.id} had ${failedSpans} malformed span(s)`.yellow);
        totalLatexFailures += failedSpans;
      }
      if (artifactStrips > 0) {
        console.warn(`[interactiveGeneration] Artifact scrub: ${block.id} had ${artifactStrips} meta-phrase(s) removed${artifactGutted > 0 ? ` (${artifactGutted} field(s) gutted → fallback used)` : ''}`.yellow);
        totalArtifactStrips += artifactStrips;
        totalArtifactGutted += artifactGutted;
      }
      return block;
    });

    if (totalLatexFailures > 0) {
      console.warn(`[interactiveGeneration] ⚠ Total LaTeX parse failures: ${totalLatexFailures}`.yellow);
    }
    if (totalArtifactStrips > 0) {
      bumpArtifactScrubStrips(totalArtifactStrips);
      for (let i = 0; i < totalArtifactGutted; i++) bumpArtifactScrubGutted();
      console.warn(`[interactiveGeneration] ⚠ Total artifact strips: ${totalArtifactStrips}${totalArtifactGutted > 0 ? `, gutted explanations: ${totalArtifactGutted}` : ''}`.yellow);
    }

    // Shuffle MCQ options for any quiz blocks so the correct answer lands in
    // a random position (breaks the LLM's positional bias — same transform
    // the module-quiz path applies via shuffleQuizOptions).
    const shuffledBlocks = sanitizedBlocks.map(shuffleQuizBlockOptions);

    // Emit each shuffled interactive block
    for (const block of shuffledBlocks) {
      console.log(`[interactiveGeneration] → ${block.id} (${block.type})`.gray);
      writer?.({ type: 'block', block });
    }

    console.log(`[interactiveGeneration] ✓ ${shuffledBlocks.length} blocks`.green);
    return { interactiveBlocks: shuffledBlocks };
  } catch (e) {
    console.warn(`[interactiveGeneration] ✗ Failed: ${e instanceof Error ? e.message : e}`.yellow);
    return { interactiveBlocks: [] };
  }
};
