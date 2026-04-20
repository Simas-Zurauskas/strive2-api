import { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getInteractiveModel } from '@lib/langchain';
import { sanitizeLatex } from '@lib/latexSanitizer';
import { sanitizeArtifacts } from '@lib/artifactSanitizer';
import { bumpArtifactScrubStrips, bumpArtifactScrubGutted } from '@lib/metrics';
import { withRetry } from '@lib/retry';
import { shuffleOptionsWithCorrectIndex } from '@lib/ai/shuffleOptions';
import { LessonState } from '../state';
import { interactiveOutputSchema, INTERACTIVE_SYSTEM_PROMPT } from '../prompts';

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

export const interactiveGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  const writer = (config?.configurable?.writer as ((event: Record<string, unknown>) => void) | undefined);

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
    const model = getInteractiveModel().withStructuredOutput(interactiveOutputSchema);
    const result = await withRetry(async () => {
      const output = await model.invoke([
        new SystemMessage(INTERACTIVE_SYSTEM_PROMPT),
        new HumanMessage(humanMessage),
      ]) as z.infer<typeof interactiveOutputSchema>;

      // Count-floor enforcement. The prompt asks for "1-2 quiz blocks and 1
      // exercise block"; when the model returns 0 of either type, retry
      // rather than accept a broken interactive section. Throwing here hooks
      // into withRetry's existing backoff; if every retry fails, the outer
      // catch returns interactiveBlocks: [] — strictly safer than rendering
      // a lesson with no exercise.
      const quizCount = output.blocks.filter((b) => b.type === 'quiz').length;
      const exerciseCount = output.blocks.filter((b) => b.type === 'exercise').length;
      if (quizCount < 1 || exerciseCount < 1) {
        throw new Error(`interactive count below floor: ${quizCount} quiz(zes), ${exerciseCount} exercise(s) — need ≥1 of each`);
      }

      return output;
    });

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
    console.warn(`[interactiveGeneration] ✗ Failed: ${e instanceof Error ? e.message : e}`.red);
    return { interactiveBlocks: [] };
  }
};
