import { RunnableConfig } from '@langchain/core/runnables';
import { sanitizePromptInput } from '@lib/sanitize';
import { genLog } from '@lib/loggers';
import LessonContentModel from '@models/LessonContentModel';
import SourceDocumentChunkModel from '@models/SourceDocumentChunkModel';
import { buildSourceVectorId, searchSourceDocuments } from '@services/sourceDocRagService';
import { wrapExternalContentBudgeted } from '../../shared/externalContent';
import { DEFAULT_SOURCE_FIDELITY, SOURCE_FIDELITY_GUIDANCE } from '../../shared/sourceFidelity';
import { LessonState } from '../state';

// Exported so peer nodes (e.g. interactiveGeneration) can render the same
// "questionId: sanitized-answer" shape into their own human messages without
// re-implementing sanitization. Returns empty string for empty input — caller
// should suppress the surrounding section header on `''` rather than rendering
// "Learner's answers: \n" with no body.
export const formatAnswers = (answers: { questionId: string; answer: string }[]): string =>
  answers.map((a) => `- ${a.questionId}: ${sanitizePromptInput(a.answer)}`).join('\n');

const formatCourseOutline = (
  structure: LessonState['structure'],
  currentModuleIndex: number,
  currentLessonIndex: number,
) => {
  return structure.modules
    .map((mod, mi) => {
      const moduleHeader = `Module ${mi + 1}: ${mod.name}`;
      const lessons = mod.lessons
        .map((lesson, li) => {
          const marker = mi === currentModuleIndex && li === currentLessonIndex ? ' ← CURRENT LESSON' : '';
          return `    ${li + 1}. ${lesson.name} — ${lesson.description}${marker}`;
        })
        .join('\n');
      return `${moduleHeader}\n  ${mod.description}\n${lessons}`;
    })
    .join('\n\n');
};

// ── Documents-course source retrieval (Phase 5, PLAN §3.1 step 6) ──
//
// Retrieval budget for the lesson prompt: refs-first (the structure's
// validated per-lesson `sourceRefs` chunk ids, fetched directly from the
// Mongo chunk manifest, course-scoped), topped up to SOURCE_RETRIEVAL_TOP_K
// total by a single semantic query over the course's document corpus. The
// assembled excerpts are wrapped untrusted with a 48 KB budget (PLAN §3.5)
// and appended to the human message — never the cached system block.
//
// Failure ladder (resilience.md §5): any retrieval error degrades to "no
// section + warning log" — a Pinecone/OpenAI blip must never fail a paid
// lesson generation. Empty retrieval likewise yields no section.

const SOURCE_RETRIEVAL_TOP_K = 10;
export const SOURCE_MATERIAL_LESSON_MAX_CHARS = 48_000;

interface RetrievedSourceChunk {
  vectorId: string;
  headingPath: string[];
  pageRange: { start: number; end: number } | null;
  text: string;
}

const formatSourceChunks = (chunks: RetrievedSourceChunk[]): string =>
  chunks
    .map((c, i) => {
      const heading = c.headingPath.length > 0 ? ` ${c.headingPath.join(' > ')}` : '';
      const pages = c.pageRange ? ` (pages ${c.pageRange.start}-${c.pageRange.end})` : '';
      return `[source ${i + 1}]${heading}${pages}\n${c.text}`;
    })
    .join('\n\n---\n\n');

const buildLessonSourceSection = async (
  state: LessonState,
  lesson: { name: string; description: string; sourceRefs?: string[] },
  moduleName: string,
): Promise<string> => {
  if (state.source !== 'documents') return '';
  try {
    // 1) Refs-first: the structure job already validated these ids against
    // the course's real chunk vectorIds, but the fetch is still scoped by
    // courseId so a stale/foreign id can never pull another course's text.
    const sourceRefs = (Array.isArray(lesson.sourceRefs) ? lesson.sourceRefs : [])
      .filter((r): r is string => typeof r === 'string')
      .slice(0, SOURCE_RETRIEVAL_TOP_K);
    const refRows = sourceRefs.length > 0
      ? await SourceDocumentChunkModel.find({ courseId: state.courseId, vectorId: { $in: sourceRefs } })
          .select('vectorId headingPath pageRange text')
          .lean()
      : [];
    const byVectorId = new Map(refRows.map((r) => [r.vectorId, r]));
    const chunks: RetrievedSourceChunk[] = sourceRefs
      .map((id) => byVectorId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({ vectorId: r.vectorId, headingPath: r.headingPath, pageRange: r.pageRange, text: r.text }));

    // 2) Semantic top-up to TOP_K total — one bounded query, deduped
    // against the refs already loaded.
    const remaining = SOURCE_RETRIEVAL_TOP_K - chunks.length;
    if (remaining > 0) {
      const query = `${lesson.name} ${lesson.description} ${moduleName}`;
      const hits = await searchSourceDocuments(state.courseId, query, { topK: SOURCE_RETRIEVAL_TOP_K });
      const seen = new Set(chunks.map((c) => c.vectorId));
      for (const hit of hits) {
        if (chunks.length >= SOURCE_RETRIEVAL_TOP_K) break;
        const vectorId = buildSourceVectorId({
          courseId: state.courseId,
          documentId: hit.documentId,
          chunkIndex: hit.chunkIndex,
        });
        if (seen.has(vectorId)) continue;
        seen.add(vectorId);
        chunks.push({ vectorId, headingPath: hit.headingPath, pageRange: hit.pageRange, text: hit.text });
      }
    }

    if (chunks.length === 0) return '';

    const fidelity = state.sourceFidelity ?? DEFAULT_SOURCE_FIDELITY;
    const wrapped = wrapExternalContentBudgeted({
      origin: 'rag:user-doc',
      content: formatSourceChunks(chunks),
      maxChars: SOURCE_MATERIAL_LESSON_MAX_CHARS,
    });
    return `## Source material (untrusted reference)

The learner created this course from their own uploaded documents. The excerpts below were retrieved for THIS lesson — ground the lesson content in them per the fidelity guidance.

Source fidelity: ${fidelity} — ${SOURCE_FIDELITY_GUIDANCE[fidelity]}

${wrapped}`;
  } catch (err) {
    // Degrade, never fail the lesson: log and generate ungrounded.
    const msg = err instanceof Error ? err.message : String(err);
    genLog.warn(
      `lesson:context-load source-retrieval degraded course=${state.courseId} lesson="${lesson.name.slice(0, 60)}" msg=${msg.slice(0, 200)}`,
    );
    return '';
  }
};

export const contextLoad = async (state: LessonState, _config?: RunnableConfig): Promise<Partial<LessonState>> => {
  const { answers, depth, domain, structure, moduleIndex, lessonIndex } = state;
  const goal = sanitizePromptInput(state.goal);

  const mod = structure.modules[moduleIndex];
  const lesson = mod.lessons[lessonIndex];
  const courseOutline = formatCourseOutline(structure, moduleIndex, lessonIndex);

  // Build position context
  const positionContext: string[] = [];
  if (moduleIndex > 0 || lessonIndex > 0) {
    const prevLessons: string[] = [];
    for (let mi = 0; mi <= moduleIndex; mi++) {
      const lessonLimit = mi === moduleIndex ? lessonIndex : structure.modules[mi].lessons.length;
      for (let li = 0; li < lessonLimit; li++) {
        prevLessons.push(structure.modules[mi].lessons[li].name);
      }
    }
    if (prevLessons.length > 0) {
      positionContext.push(`Previous lessons already covered: ${prevLessons.join(', ')}. Do NOT repeat content from these lessons.`);
    }

    // Load the immediately preceding lesson's summary for content coherence
    const prevModuleIndex = lessonIndex > 0 ? moduleIndex : moduleIndex - 1;
    const prevLessonIndex = lessonIndex > 0 ? lessonIndex - 1 : (structure.modules[moduleIndex - 1]?.lessons.length ?? 1) - 1;
    if (prevModuleIndex >= 0) {
      const prevContent = await LessonContentModel.findOne(
        { courseId: state.courseId, moduleIndex: prevModuleIndex, lessonIndex: prevLessonIndex },
      ).select('summary').lean();
      if (prevContent?.summary) {
        const prevName = structure.modules[prevModuleIndex].lessons[prevLessonIndex]?.name ?? 'previous lesson';
        positionContext.push(`Summary of the previous lesson ("${prevName}"): ${prevContent.summary}\n\nBuild on this knowledge — reference concepts the learner already learned and use consistent terminology.`);
      }
    }
  }

  const nextLessons: string[] = [];
  for (let li = lessonIndex + 1; li < mod.lessons.length; li++) {
    nextLessons.push(mod.lessons[li].name);
  }
  if (nextLessons.length > 0) {
    positionContext.push(`Upcoming lessons in this module: ${nextLessons.join(', ')}. You may reference these to set expectations but do not teach their content.`);
  }

  // Documents course only ('' otherwise, including on any retrieval
  // failure) — the goal-course humanMessage below stays byte-identical
  // (pinned by coursePromptPin.test.ts).
  const sourceSection = await buildLessonSourceSection(state, lesson, mod.name);

  const humanMessage = `## Course context

Learning goal: ${goal}
Course depth: ${depth}${domain ? `\nCourse domain: ${domain}` : ''}

Learner's answers to clarifying questions:
${formatAnswers(answers)}

## Full course outline

${courseOutline}

## Lesson to generate

Module ${moduleIndex + 1}: ${mod.name}
Lesson ${lessonIndex + 1}: ${lesson.name}
Description: ${lesson.description}

${positionContext.length > 0 ? `## Position context\n\n${positionContext.join('\n\n')}` : ''}

${sourceSection ? `${sourceSection}\n\n` : ''}Generate the full lesson content as structured blocks.`;

  genLog.info(
    `lesson:context-load module=${moduleIndex} lesson=${lessonIndex} name="${lesson.name}" prevSummaryLoaded=${positionContext.length > 0} sourceMaterial=${sourceSection !== ''}`,
  );

  // Defensive sanitization of the state fields that later prompt nodes
  // interpolate directly (interactiveGeneration embeds lessonName,
  // lessonDescription, moduleName into its human message). These are
  // LLM-generated — and the first-stage LLM has a strong system prompt —
  // but second-order prompt injection via a malformed lesson name has
  // essentially zero latency to defend against, so we strip the obvious
  // override patterns here rather than relying on downstream discipline.
  return {
    humanMessage,
    hasSourceMaterial: sourceSection !== '',
    lessonName: sanitizePromptInput(lesson.name),
    lessonDescription: sanitizePromptInput(lesson.description),
    moduleName: sanitizePromptInput(mod.name),
  };
};
