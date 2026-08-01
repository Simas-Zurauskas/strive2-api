import { RunnableConfig } from '@langchain/core/runnables';
import { generateObject, NoObjectGeneratedError } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { MODEL_IDS } from '@lib/langchain';
import { sanitizeLatex } from '@lib/latexSanitizer';
import { logCacheUsage, usageFromVercelAi } from '@lib/ai/cacheLogger';
import {
  bumpContentValidationRepairHaikuAttempt,
  bumpContentValidationRepairHaikuFallback,
} from '@lib/metrics';
import type { LessonProgressWriter } from '@src/types/socketEvents';
import { genLog } from '@lib/loggers';
import { captureWarning } from '@lib/errorReporter';
import { LessonState } from '../state';
import { lessonBlockSchema } from '../prompts';

// Wall-clock cap on the AI-SDK `generateObject` call. The repair path is a
// small structured emission (≤4 missing blocks), so 2 minutes is generous;
// the bound exists because the AI SDK does not enforce its own timeout —
// without `abortSignal`, a stalled Anthropic connection would hang the
// repair indefinitely. The outer try/catch in `runRepair` handles
// `AbortError` the same way it handles `NoObjectGeneratedError`: fall
// through to the Sonnet escalation, then to the no-op return.
const VALIDATION_TIMEOUT_MS = 120_000; // 2 minutes

// Mirror of the helper in contentGeneration.ts. When generateObject rejects,
// the terse "response did not match schema" message is all the Job record
// keeps; the real reason lives on .cause (ZodError), and the raw output on
// .text. Log both so repair-path failures are diagnosable from stdout.
const logNoObjectDetails = (label: string, err: unknown): void => {
  if (!NoObjectGeneratedError.isInstance(err)) return;
  const cause = err.cause;
  const causeMsg = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  genLog.error(`lesson:validate ${label} no-object cause=${causeMsg}`);
  if (typeof err.text === 'string' && err.text.length > 0) {
    genLog.error(`lesson:validate ${label} raw-tail=${err.text.slice(-600)}`);
  }
  if (err.usage) {
    genLog.error(`lesson:validate ${label} usage=${JSON.stringify(err.usage)}`);
  }
};

// Block types whose `content` is markdown-ish and may contain LaTeX math.
// `code` and `mermaid` carry domain-specific syntax and must never be sanitized.
const MATH_BEARING_TYPES = new Set(['intro', 'section', 'callout', 'summary']);

// ── Section title + first-paragraph helpers ──

/**
 * Pull the first markdown heading (# through ###) from a section block's
 * content. Returns '' when the content doesn't open with a heading — which
 * itself is a malformed-start signal handled separately below.
 */
function extractSectionTitle(content: string): string {
  const match = content.trim().match(/^#{1,3}\s+(.+)/);
  return match ? match[1].trim() : '';
}

/**
 * True if a section's first non-whitespace character is a markdown heading
 * marker or starts a proper sentence (uppercase / digit / opening quote).
 * Catches regressions like Hiroshi's Lesson [1/2] section that opened with
 * "what's happening is that…" — a mid-sentence fragment shipped to the
 * learner because the upstream prose got sliced wrong.
 */
function hasValidSectionStart(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  // Proper markdown heading start is always OK.
  if (/^#{1,3}\s+\S/.test(trimmed)) return true;
  // Fallback: first char should be uppercase letter, digit, or a typical
  // sentence opener (quote, backtick, bullet, or LaTeX delimiter).
  return /^[A-Z0-9"'`*\-[$]/.test(trimmed);
}

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
  writer?: LessonProgressWriter;
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

  genLog.warn(`lesson:validate repair-start missing=[${missing.join(' | ')}]`);

  // Track which types we need so we can filter out unexpected ones
  const allowedTypes = new Set<string>();
  if (gaps.missingIntro) allowedTypes.add('intro');
  if (gaps.missingSummary) allowedTypes.add('summary');
  if (gaps.needMoreSections > 0) allowedTypes.add('section');

  // Repair is pure structured extraction with a clear schema — Haiku handles
  // this reliably at temperature 0. We try Haiku first (5× cheaper than
  // Sonnet per token); on NoObjectGeneratedError or empty output, fall back
  // to Sonnet so a rare Haiku parse miss never costs the lesson its
  // structural blocks. Both calls stream through `logCacheUsage` for
  // cost attribution — the prior implementation was uninstrumented.
  const systemPrompt = `You are repairing an incomplete lesson. The lesson generation produced content blocks but is missing required structural blocks. Generate ONLY the missing blocks listed below. Match the style, depth, and topic of the existing content.\n\nRules:\n- Use the id format "type-repair-N" (e.g., "intro-repair-1", "summary-repair-1", "section-repair-1")\n- For intro blocks: order should be -1 (will be placed at the start)\n- For section blocks: order should increment from ${nextSectionOrder}\n- For summary blocks: order should be ${summaryOrder} (always last)\n- Content must be consistent with the existing blocks below`;
  const userPrompt = `## Existing blocks\n\n${existingBlocksSummary}\n\n## Missing blocks to generate\n\n${missing.map((m) => `- ${m}`).join('\n')}\n\nGenerate ONLY the missing blocks. Do not duplicate existing content.`;

  const runRepair = async ({ modelId, label }: { modelId: string; label: string }) => {
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => {
      genLog.warn(`lesson:validate ${label} timeout (${VALIDATION_TIMEOUT_MS}ms) — aborting`);
      abortController.abort();
    }, VALIDATION_TIMEOUT_MS);
    try {
      const isSonnet = modelId === MODEL_IDS.SONNET;
      const result = await generateObject({
        model: anthropic(modelId),
        schema: z.object({ blocks: z.array(lessonBlockSchema) }),
        // Sonnet 5 rejects `temperature` (400) — only the Haiku attempt may
        // send it. The Sonnet fallback also pins thinking off (omitted =
        // adaptive-ON on Sonnet 5) and an explicit output cap so the SDK's
        // per-model default can never truncate a repair.
        ...(isSonnet
          ? {
              maxOutputTokens: 8192,
              providerOptions: { anthropic: { thinking: { type: 'disabled' as const } } },
            }
          : { temperature: 0.3 }),
        abortSignal: abortController.signal,
        messages: [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: userPrompt },
        ],
      });
      logCacheUsage({
        label,
        usage: usageFromVercelAi({
          providerMetadata: result.providerMetadata,
          usage: result.usage,
        }),
        model: modelId,
      });
      return result.object;
    } finally {
      clearTimeout(abortTimer);
    }
  };

  let object: { blocks: LessonState['contentBlocks'] };
  try {
    bumpContentValidationRepairHaikuAttempt();
    object = await runRepair({ modelId: MODEL_IDS.HAIKU, label: 'lesson:validation-repair.haiku' });
    if (object.blocks.filter((b) => allowedTypes.has(b.type)).length === 0) {
      // Haiku returned but nothing matched the allowed-types gate — treat as
      // a soft failure and escalate to Sonnet rather than shipping the
      // original (broken) blocks unchanged.
      throw new Error('Haiku produced zero usable blocks after allowed-types filter');
    }
  } catch (haikuError) {
    const haikuMsg = haikuError instanceof Error ? haikuError.message : String(haikuError);
    genLog.warn(`lesson:validate repair-haiku-fallthrough reason=${haikuMsg} — retrying on Sonnet`);
    bumpContentValidationRepairHaikuFallback();
    try {
      object = await runRepair({ modelId: MODEL_IDS.SONNET, label: 'lesson:validation-repair.sonnet' });
    } catch (sonnetError) {
      const reason = sonnetError instanceof Error ? sonnetError.message : String(sonnetError);
      genLog.error(`lesson:validate repair-both-fail reason=${reason}`);
      logNoObjectDetails('contentValidation.repair', sonnetError);
      // Silent degradation: both Haiku and Sonnet repair calls failed and
      // we're returning the (still-broken) original blocks. The lesson will
      // ship without the missing structural blocks the gate detected.
      // Surfacing this to Sentry is critical — the user won't see a 5xx
      // (the lesson "succeeded") but the gating logic was bypassed.
      captureWarning('lesson:validate repair-both-fail', {
        tags: { agent: 'lessonGeneration', node: 'contentValidation', stage: 'repair' },
        extra: { reason, blockCount: blocks.length, missing: missing.join(' | ') },
        fingerprint: ['lessonGeneration', 'contentValidation', 'repair-both-fail'],
      });
      return blocks;
    }
  }

  try {
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

    genLog.info(`lesson:validate repair-ok generated=${repairedBlocks.length}`);
    return [...blocks, ...repairedBlocks];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    genLog.error(`lesson:validate repair-postprocess-fail reason=${reason}`);
    logNoObjectDetails('contentValidation.repair', error);
    // Silent degradation on the post-processing path (filter / re-order /
    // emit). Same rationale as repair-both-fail above — surface so we can
    // tell whether the lesson shipped with intended or accidental content.
    captureWarning('lesson:validate repair-postprocess-fail', {
      tags: { agent: 'lessonGeneration', node: 'contentValidation', stage: 'postprocess' },
      extra: { reason, blockCount: blocks.length },
      fingerprint: ['lessonGeneration', 'contentValidation', 'postprocess-fail'],
    });
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
  const writer = config?.configurable?.writer as LessonProgressWriter | undefined;

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
  let sanitizedMermaidLabels = 0;
  for (const block of mermaidBlocks) {
    // Inside double-quoted node/edge labels, the LLM sometimes emits the
    // 2-char sequence `\n` (JSON-escape thinking) where mermaid wants
    // `<br/>`. Mermaid renders literal `\n` as text, which breaks the
    // diagram. Substitute only within quoted spans so structural newlines
    // between statements are preserved.
    const normalized = block.content.replace(/"([^"]*)"/g, (_match, inner: string) => {
      if (!inner.includes('\\n')) return `"${inner}"`;
      sanitizedMermaidLabels += 1;
      return `"${inner.replace(/\\n/g, '<br/>')}"`;
    });
    if (normalized !== block.content) {
      block.content = normalized;
    }

    const firstLine = block.content.trim().split('\n')[0].trim();
    const startsValid = validDiagramStarts.some((prefix) => firstLine.startsWith(prefix));
    if (!startsValid) {
      warnings.push(`Mermaid block ${block.id} doesn't start with a valid diagram type: "${firstLine.slice(0, 50)}"`);
    }
    if (!block.metadata?.diagramType) {
      warnings.push(`Mermaid block ${block.id} missing metadata.diagramType`);
    }
  }
  if (sanitizedMermaidLabels > 0) {
    genLog.info(`lesson:validate mermaid-normalize labels=${sanitizedMermaidLabels} (\\n → <br/>)`);
  }

  // Check callout blocks have variant set
  const calloutBlocks = blocks.filter((b) => b.type === 'callout');
  for (const block of calloutBlocks) {
    if (!block.metadata?.variant) {
      warnings.push(`Callout block ${block.id} missing metadata.variant`);
    }
  }

  if (warnings.length > 0) {
    genLog.warn(`lesson:validate issues=${warnings.length} list=[${warnings.join(' | ')}]`);
  } else {
    genLog.info(`lesson:validate ok blocks=${blocks.length}`);
  }

  // ── Section-title dedup (case-insensitive) ──
  // The LLM occasionally emits the same section twice (observed in Olivia's
  // Lesson [0/2] "Pro Mode Actually Gives You" and Nina's Lesson [1/2]
  // "Launching the Notebook"). We keep the first occurrence and drop
  // subsequent copies. When this brings the section count below the
  // structural floor, the repair loop below regenerates fresh sections.
  const seenTitles = new Map<string, string>(); // normalized title → first-seen block id
  const duplicatesRemoved: { id: string; title: string }[] = [];
  blocks = blocks.filter((b) => {
    if (b.type !== 'section') return true;
    const title = extractSectionTitle(b.content);
    if (!title) return true; // malformed-start path handles no-title case
    const key = title.toLowerCase();
    if (seenTitles.has(key)) {
      duplicatesRemoved.push({ id: b.id, title });
      return false;
    }
    seenTitles.set(key, b.id);
    return true;
  });
  if (duplicatesRemoved.length > 0) {
    for (const { id, title } of duplicatesRemoved) {
      const firstId = seenTitles.get(title.toLowerCase());
      genLog.warn(`lesson:validate dedup-section drop=${id} firstSeen=${firstId} title="${title}"`);
      warnings.push(`Removed duplicate section ${id}: "${title}"`);
    }
  }

  // ── Malformed-start detector (warn only) ──
  // Flag sections whose content starts mid-sentence or otherwise doesn't
  // open cleanly. We don't drop these — doing so would risk discarding
  // substantive teaching material over a formatting glitch. The warning
  // surfaces in the debug recorder for per-run inspection.
  for (const b of blocks) {
    if (b.type !== 'section') continue;
    if (hasValidSectionStart(b.content)) continue;
    const preview = b.content.trim().slice(0, 60);
    genLog.warn(`lesson:validate malformed-section block=${b.id} preview="${preview}..."`);
    warnings.push(`Section ${b.id} starts malformed: "${preview}..."`);
  }

  // ── Structural repair: attempt to generate missing required blocks ──
  // Runs up to MAX_REPAIR_ATTEMPTS rounds. A single repair call can itself
  // come back thin (the LLM occasionally returns only 1 of 2 requested sections,
  // or a summary that gets filtered out by the allowedTypes gate). Looping a
  // second time gives structurally-broken lessons a real chance to be made valid
  // before they reach the client.
  // Raised from 2 → 3: the post-dedup path can turn a "had-5-sections-two-duplicates"
  // lesson into a "needs 1 section regenerated" case, and that regeneration can
  // itself come back thin. Three attempts reliably converges in practice without
  // meaningfully lengthening the happy-path latency (no attempt fires when no gap exists).
  const MAX_REPAIR_ATTEMPTS = 3;
  let prevBlockCount = blocks.length;
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const gaps = detectStructuralGaps(blocks);
    const needsRepair = gaps.missingIntro || gaps.missingSummary || gaps.needMoreSections > 0;
    if (!needsRepair) break;

    if (attempt > 1) {
      genLog.info(`lesson:validate repair-attempt ${attempt}/${MAX_REPAIR_ATTEMPTS}`);
    }
    blocks = await repairStructuralGaps({ blocks, gaps, writer });

    // No-progress guard: repair's catch block returns the input blocks
    // unchanged on LLM failure, and the model can also legitimately return
    // zero usable blocks (all filtered out by the allowedTypes gate). In
    // either case, a next iteration would fire with identical gaps and
    // almost certainly produce the same outcome — so stop here.
    if (blocks.length === prevBlockCount) {
      genLog.warn(`lesson:validate repair-noprogress attempt=${attempt} — stopping`);
      break;
    }
    prevBlockCount = blocks.length;
  }

  // Final post-repair log (only if we actually ran repair at all)
  const needsInitialRepair = (() => {
    const g = detectStructuralGaps(state.contentBlocks);
    return g.missingIntro || g.missingSummary || g.needMoreSections > 0;
  })();
  if (needsInitialRepair) {
    const postIntro = blocks.filter((b) => b.type === 'intro').length;
    const postSummary = blocks.filter((b) => b.type === 'summary').length;
    const postSections = blocks.filter((b) => b.type === 'section').length;
    const stillBroken = postIntro !== 1 || postSummary !== 1 || postSections < 2;
    if (stillBroken) {
      genLog.warn(`lesson:validate post-repair-incomplete intro=${postIntro} summary=${postSummary} sections=${postSections}`);
    } else {
      genLog.info(`lesson:validate post-repair-ok intro=${postIntro} summary=${postSummary} sections=${postSections}`);
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
    genLog.warn(`lesson:validate code→section block=${b.id} (non-code content detected)`);
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
    genLog.warn(`lesson:validate latex-sanitize block=${b.id} failedSpans=${failedSpans}`);
    return { ...b, content: text };
  });

  if (totalLatexFailures > 0) {
    genLog.warn(`lesson:validate latex-failures total=${totalLatexFailures}`);
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
