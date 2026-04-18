import { RunnableConfig } from '@langchain/core/runnables';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { MODEL_IDS } from '@lib/langchain';
import { sanitizeLatex } from '@lib/latexSanitizer';
import { LessonState } from '../state';
import { lessonBlockSchema } from '../prompts';

// Block types whose `content` is markdown-ish and may contain LaTeX math.
// `code` and `mermaid` carry domain-specific syntax and must never be sanitized.
const MATH_BEARING_TYPES = new Set(['intro', 'section', 'callout', 'summary']);

// ── Heuristics for detecting non-code content in code blocks ──

function isLikelyNotCode(content: string): boolean {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  // 1. High comment-line ratio (heading-style comments like "# Some Title")
  const headingComments = lines.filter((l) => /^\s*#\s+[A-Z]/.test(l));
  if (headingComments.length / lines.length > 0.4) return true;

  // 2. Multiple natural language sentences (long lines with many words ending in punctuation)
  const sentenceLines = lines.filter((l) => {
    const t = l.trim();
    return t.length > 60 && t.split(/\s+/).length > 8 && /[.!?:]$/.test(t);
  });
  if (sentenceLines.length >= 2) return true;

  // 3. No programming constructs at all
  const codePatterns = [
    /\b(function|def|class|const|let|var|import|export|from|return|if|else|for|while|switch|case|try|catch|throw|async|await)\b/,
    /[=!<>]=|&&|\|\|/, // operators
    /\w+\(.*\)/, // function calls
    /[{}\[\]();]/, // braces and semicolons
    /^\s*(npm|pip|yarn|cargo|brew|apt|curl|wget|docker|git|cd|ls|mkdir|chmod|ssh|cat|echo|grep|sed|awk|make|go|rustc|javac|gcc|node|python3?|ruby)\s/m, // CLI commands
  ];
  const hasCodePattern = codePatterns.some((p) => p.test(content));
  if (!hasCodePattern) return true;

  // 4. Template/checklist pattern: majority of lines are "Label: Value" or "- [ ]" items
  const labelValueLines = lines.filter((l) => /^\s*[-•*]?\s*[\w\s]+:\s+\S/.test(l));
  const checklistLines = lines.filter((l) => /^\s*[-•*]\s*\[[ x]\]/i.test(l));
  if ((labelValueLines.length + checklistLines.length) / lines.length > 0.5) return true;

  return false;
}

function reformatAsSection(content: string): string {
  const lines = content.split('\n');
  let title = '';

  const reformatted = lines
    .map((line) => {
      // Convert "# HEADING" style comments to markdown headings
      const headingMatch = line.match(/^\s*#{1,3}\s+(.+)/);
      if (headingMatch) {
        const heading = headingMatch[1].trim();
        if (!title) title = heading;
        return `## ${heading}`;
      }
      // Convert "Key: Value" lines to bold key
      const kvMatch = line.match(/^(\s*[-•*]?\s*)([\w\s/]+):\s+(.+)/);
      if (kvMatch) {
        const [, indent, key, value] = kvMatch;
        return `${indent}**${key.trim()}:** ${value.trim()}`;
      }
      return line;
    })
    .join('\n');

  return title ? `## ${title}\n\n${reformatted}` : reformatted;
}

// ── Structural repair: generate missing required blocks ──

interface StructuralGaps {
  missingIntro: boolean;
  missingSummary: boolean;
  needMoreSections: number; // 0 = fine, >0 = how many extra sections needed
}

function detectStructuralGaps(blocks: LessonState['contentBlocks']): StructuralGaps {
  const introCount = blocks.filter((b) => b.type === 'intro').length;
  const summaryCount = blocks.filter((b) => b.type === 'summary').length;
  const sectionCount = blocks.filter((b) => b.type === 'section').length;

  return {
    missingIntro: introCount === 0,
    missingSummary: summaryCount === 0,
    needMoreSections: sectionCount < 2 ? 2 - sectionCount : 0,
  };
}

async function repairStructuralGaps({
  blocks,
  gaps,
  writer,
}: {
  blocks: LessonState['contentBlocks'];
  gaps: StructuralGaps;
  writer?: (event: Record<string, unknown>) => void;
}): Promise<LessonState['contentBlocks']> {
  const missing: string[] = [];
  if (gaps.missingIntro) missing.push('1 "intro" block (2-4 sentence compelling opening)');
  if (gaps.missingSummary) missing.push('1 "summary" block (4-6 bullet points of key takeaways, no heading)');
  if (gaps.needMoreSections > 0) missing.push(`${gaps.needMoreSections} additional "section" block(s) (150-400 words each, starting with ## heading)`);

  const maxOrder = Math.max(...blocks.map((b) => b.order), -1);
  const existingBlocksSummary = blocks.map((b) => `[${b.type}] id=${b.id}, order=${b.order}: ${b.content.slice(0, 100)}...`).join('\n');

  // Compute correct ordering: sections come before summary, intro before everything
  // Sections fill slots after existing content, summary is always last
  let nextSectionOrder = maxOrder + 1;
  const summaryOrder = maxOrder + gaps.needMoreSections + 1;

  console.log(`[contentValidation] 🔄 Attempting repair: generating ${missing.join(', ')}`.yellow);

  // Track which types we need so we can filter out unexpected ones
  const allowedTypes = new Set<string>();
  if (gaps.missingIntro) allowedTypes.add('intro');
  if (gaps.missingSummary) allowedTypes.add('summary');
  if (gaps.needMoreSections > 0) allowedTypes.add('section');

  try {
    const { object } = await generateObject({
      model: anthropic(MODEL_IDS.SONNET),
      schema: z.object({ blocks: z.array(lessonBlockSchema) }),
      temperature: 0.3,
      messages: [
        {
          role: 'system' as const,
          content: `You are repairing an incomplete lesson. The lesson generation produced content blocks but is missing required structural blocks. Generate ONLY the missing blocks listed below. Match the style, depth, and topic of the existing content.\n\nRules:\n- Use the id format "type-repair-N" (e.g., "intro-repair-1", "summary-repair-1", "section-repair-1")\n- For intro blocks: order should be -1 (will be placed at the start)\n- For section blocks: order should increment from ${nextSectionOrder}\n- For summary blocks: order should be ${summaryOrder} (always last)\n- Content must be consistent with the existing blocks below`,
        },
        {
          role: 'user' as const,
          content: `## Existing blocks\n\n${existingBlocksSummary}\n\n## Missing blocks to generate\n\n${missing.map((m) => `- ${m}`).join('\n')}\n\nGenerate ONLY the missing blocks. Do not duplicate existing content.`,
        },
      ],
    });

    // Discard any blocks the LLM generated with unexpected types
    const repairedBlocks = object.blocks.filter((b) => allowedTypes.has(b.type));

    // Enforce correct ordering regardless of what the LLM produced
    for (const block of repairedBlocks) {
      if (block.type === 'intro') {
        block.order = -1;
      } else if (block.type === 'section') {
        block.order = nextSectionOrder++;
      } else if (block.type === 'summary') {
        block.order = summaryOrder;
      }
    }

    // Stream repaired blocks to client
    for (const block of repairedBlocks) {
      writer?.({ type: 'block', block });
    }

    console.log(`[contentValidation] ✓ Repair complete: generated ${repairedBlocks.length} blocks`.green);
    return [...blocks, ...repairedBlocks];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[contentValidation] ✗ Repair failed: ${reason}`.red);
    return blocks; // Fall back to original blocks
  }
}

/**
 * Lightweight validation node that checks content blocks for structural issues
 * before they flow to interactive generation and merge.
 * When required blocks are missing (intro, summary, sections), attempts a single
 * targeted repair via LLM before continuing. Other warnings are log-only.
 */
export const contentValidation = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  let blocks = state.contentBlocks;
  const warnings: string[] = [];
  const writer = config?.configurable?.writer as ((event: Record<string, unknown>) => void) | undefined;

  // Check required block types
  const introBlocks = blocks.filter((b) => b.type === 'intro');
  const summaryBlocks = blocks.filter((b) => b.type === 'summary');
  const sectionBlocks = blocks.filter((b) => b.type === 'section');

  if (introBlocks.length !== 1) warnings.push(`Expected 1 intro block, got ${introBlocks.length}`);
  if (summaryBlocks.length !== 1) warnings.push(`Expected 1 summary block, got ${summaryBlocks.length}`);
  if (sectionBlocks.length < 2 || sectionBlocks.length > 5) warnings.push(`Expected 2-5 section blocks, got ${sectionBlocks.length}`);

  // Check code blocks have language set
  const codeBlocks = blocks.filter((b) => b.type === 'code');
  for (const block of codeBlocks) {
    if (!block.metadata?.language) {
      warnings.push(`Code block ${block.id} missing metadata.language`);
    }
  }

  // Check mermaid blocks start with a valid diagram type
  const mermaidBlocks = blocks.filter((b) => b.type === 'mermaid');
  const validDiagramStarts = ['flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'erDiagram', 'mindmap', 'graph'];
  for (const block of mermaidBlocks) {
    const firstLine = block.content.trim().split('\n')[0].trim();
    const startsValid = validDiagramStarts.some((prefix) => firstLine.startsWith(prefix));
    if (!startsValid) {
      warnings.push(`Mermaid block ${block.id} doesn't start with a valid diagram type: "${firstLine.slice(0, 50)}"`);
    }
    if (!block.metadata?.diagramType) {
      warnings.push(`Mermaid block ${block.id} missing metadata.diagramType`);
    }
  }

  // Check callout blocks have variant set
  const calloutBlocks = blocks.filter((b) => b.type === 'callout');
  for (const block of calloutBlocks) {
    if (!block.metadata?.variant) {
      warnings.push(`Callout block ${block.id} missing metadata.variant`);
    }
  }

  if (warnings.length > 0) {
    console.warn(`[contentValidation] ⚠ ${warnings.length} issues found:`.yellow);
    for (const w of warnings) console.warn(`  - ${w}`.yellow);
  } else {
    console.log(`[contentValidation] ✓ All checks passed (${blocks.length} blocks)`.green);
  }

  // ── Structural repair: attempt to generate missing required blocks ──
  const gaps = detectStructuralGaps(blocks);
  if (gaps.missingIntro || gaps.missingSummary || gaps.needMoreSections > 0) {
    blocks = await repairStructuralGaps({ blocks, gaps, writer });

    // Log post-repair validation
    const postIntro = blocks.filter((b) => b.type === 'intro').length;
    const postSummary = blocks.filter((b) => b.type === 'summary').length;
    const postSections = blocks.filter((b) => b.type === 'section').length;
    const stillBroken = postIntro !== 1 || postSummary !== 1 || postSections < 2;
    if (stillBroken) {
      console.warn(`[contentValidation] ⚠ Post-repair: intro=${postIntro}, summary=${postSummary}, sections=${postSections} — still incomplete`.yellow);
    } else {
      console.log(`[contentValidation] ✓ Post-repair: structure valid (intro=${postIntro}, summary=${postSummary}, sections=${postSections})`.green);
    }
  }

  // Remove placeholder code blocks (LLM sometimes generates "no code needed" stubs for non-technical lessons)
  const filtered = blocks.filter((b) => {
    if (b.type !== 'code') return true;
    const trimmed = b.content.trim().replace(/^#\s*/, '').toLowerCase();
    if (trimmed.includes('no code') || trimmed.includes('not applicable') || trimmed.includes('no programming') || trimmed.length < 20) {
      warnings.push(`Removed empty/placeholder code block ${b.id}: "${b.content.trim().slice(0, 60)}"`);
      return false;
    }
    return true;
  });

  // Convert non-code content in code blocks to section blocks
  let converted = false;
  const corrected = filtered.map((b) => {
    if (b.type !== 'code') return b;
    if (!isLikelyNotCode(b.content)) return b;

    converted = true;
    const newId = b.id.replace(/^code-/, 'section-converted-');
    console.warn(`[contentValidation] Converting code block ${b.id} → section (detected non-code content)`.yellow);
    warnings.push(`Converted non-code code block ${b.id} to section`);

    return {
      ...b,
      id: newId,
      type: 'section' as const,
      content: reformatAsSection(b.content),
      metadata: null,
    };
  });

  // ── LaTeX sanitization: catch malformed math spans server-side ──
  // Broken LaTeX from the LLM would otherwise surface as KaTeX error nodes
  // (rehype-katex throwOnError: false) or, worse, silently wrong rendering.
  // Replace failing spans with inline-code fallbacks before the blocks hit the client.
  let totalLatexFailures = 0;
  const sanitized = corrected.map((b) => {
    if (!MATH_BEARING_TYPES.has(b.type) || !b.content) return b;
    const { text, failedSpans } = sanitizeLatex(b.content);
    if (failedSpans === 0) return b;
    totalLatexFailures += failedSpans;
    console.warn(`[contentValidation] LaTeX sanitize: block ${b.id} had ${failedSpans} malformed span(s)`.yellow);
    return { ...b, content: text };
  });

  if (totalLatexFailures > 0) {
    console.warn(`[contentValidation] ⚠ Total LaTeX parse failures: ${totalLatexFailures}`.yellow);
  }

  // Return updated blocks if anything changed (repair, filtering, conversion, or LaTeX fix-ups)
  const blocksChanged =
    blocks !== state.contentBlocks ||
    converted ||
    filtered.length !== blocks.length ||
    totalLatexFailures > 0;
  if (blocksChanged) {
    return { contentBlocks: sanitized };
  }

  return {};
};
