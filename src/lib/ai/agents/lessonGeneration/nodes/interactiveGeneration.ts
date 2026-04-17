import { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getInteractiveModel } from '@lib/langchain';
import { sanitizeLatex } from '@lib/latexSanitizer';
import { withRetry } from '@lib/retry';
import { LessonState } from '../state';
import { interactiveOutputSchema, INTERACTIVE_SYSTEM_PROMPT } from '../prompts';

// Sanitize LaTeX in an interactive block's markdown-bearing fields.
// Returns the block with any failing spans replaced, plus the failure count.
const sanitizeInteractiveBlock = (block: LessonState['interactiveBlocks'][number]) => {
  let failedSpans = 0;
  const out = { ...block };

  if (typeof out.content === 'string' && out.content.length > 0) {
    const res = sanitizeLatex(out.content);
    if (res.failedSpans > 0) {
      failedSpans += res.failedSpans;
      out.content = res.text;
    }
  }

  if (out.type === 'quiz' && out.metadata && typeof out.metadata === 'object') {
    const meta: Record<string, unknown> = { ...out.metadata };
    for (const key of ['question', 'explanation'] as const) {
      if (typeof meta[key] === 'string') {
        const res = sanitizeLatex(meta[key] as string);
        if (res.failedSpans > 0) {
          failedSpans += res.failedSpans;
          meta[key] = res.text;
        }
      }
    }
    if (Array.isArray(meta.options)) {
      meta.options = (meta.options as unknown[]).map((opt) => {
        if (typeof opt !== 'string') return opt;
        const res = sanitizeLatex(opt);
        if (res.failedSpans > 0) failedSpans += res.failedSpans;
        return res.text;
      });
    }
    out.metadata = meta;
  }

  return { block: out, failedSpans };
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
    const result = await withRetry(() =>
      model.invoke([new SystemMessage(INTERACTIVE_SYSTEM_PROMPT), new HumanMessage(humanMessage)]),
    ) as z.infer<typeof interactiveOutputSchema>;

    // Sanitize LaTeX in every interactive block before emitting to the client
    let totalLatexFailures = 0;
    const sanitizedBlocks = result.blocks.map((b) => {
      const { block, failedSpans } = sanitizeInteractiveBlock(b);
      if (failedSpans > 0) {
        console.warn(`[interactiveGeneration] LaTeX sanitize: ${block.id} had ${failedSpans} malformed span(s)`.yellow);
        totalLatexFailures += failedSpans;
      }
      return block;
    });

    if (totalLatexFailures > 0) {
      console.warn(`[interactiveGeneration] ⚠ Total LaTeX parse failures: ${totalLatexFailures}`.yellow);
    }

    // Emit each sanitized interactive block
    for (const block of sanitizedBlocks) {
      console.log(`[interactiveGeneration] → ${block.id} (${block.type})`.gray);
      writer?.({ type: 'block', block });
    }

    console.log(`[interactiveGeneration] ✓ ${sanitizedBlocks.length} blocks`.green);
    return { interactiveBlocks: sanitizedBlocks };
  } catch (e) {
    console.warn(`[interactiveGeneration] ✗ Failed: ${e instanceof Error ? e.message : e}`.red);
    return { interactiveBlocks: [] };
  }
};
