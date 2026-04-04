import { RunnableConfig } from '@langchain/core/runnables';
import { LessonState } from '../state';

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

  if (filtered.length !== blocks.length) {
    return { contentBlocks: filtered };
  }

  return {};
};
