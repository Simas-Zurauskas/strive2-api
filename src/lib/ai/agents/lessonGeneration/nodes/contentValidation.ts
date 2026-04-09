import { RunnableConfig } from '@langchain/core/runnables';
import { LessonState } from '../state';

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

/**
 * Lightweight validation node that checks content blocks for structural issues
 * before they flow to interactive generation and merge.
 * Logs warnings but does not block the pipeline — acts as a quality signal.
 */
export const contentValidation = async (state: LessonState, _config?: RunnableConfig): Promise<Partial<LessonState>> => {
  const blocks = state.contentBlocks;
  const warnings: string[] = [];

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

  if (converted || filtered.length !== blocks.length) {
    return { contentBlocks: corrected };
  }

  return {};
};
