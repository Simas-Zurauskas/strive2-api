import { SourceFidelity } from '@lib/constants';

/**
 * Single source of truth for how each `course.sourceFidelity` value steers
 * generation on a documents course (Phase 5 of course-from-documents,
 * PLAN §3.1 steps 5–6). Consumed by:
 *   - `courseService` — structure / refine human-message guidance,
 *   - `lessonGeneration/nodes/contextLoad` — the fidelity line beside the
 *     retrieved source material,
 *   - `lessonGeneration/prompts` — the grounding section of the lesson
 *     system prompt.
 *
 * One sentence per mode, imperative, addressed to the generating model.
 * `guided` is the product default (Q4) — a null `sourceFidelity` on a
 * documents course reads as `guided`.
 */
export const SOURCE_FIDELITY_GUIDANCE: Record<SourceFidelity, string> = {
  strict:
    'Teach ONLY what the source material covers. Where the sources are silent on something the course would normally include, flag the gap honestly instead of filling it with outside knowledge.',
  guided:
    "Follow the sources' scope and structure. Fill small gaps with your own knowledge where the sources fall short, clearly marked as supplementary.",
  enrich:
    'Use the sources as the spine of the course, and broaden freely with related knowledge that deepens or contextualizes what the documents cover.',
};

/** `guided` is the default fidelity (PLAN Q4) when the course has none set. */
export const DEFAULT_SOURCE_FIDELITY: SourceFidelity = 'guided';
