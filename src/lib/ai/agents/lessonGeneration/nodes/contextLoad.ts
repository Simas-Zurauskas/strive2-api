import { RunnableConfig } from '@langchain/core/runnables';
import { sanitizePromptInput } from '@lib/sanitize';
import { genLog } from '@lib/loggers';
import LessonContentModel from '@models/LessonContentModel';
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

Generate the full lesson content as structured blocks.`;

  genLog.info(
    `lesson:context-load module=${moduleIndex} lesson=${lessonIndex} name="${lesson.name}" prevSummaryLoaded=${positionContext.length > 0}`,
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
    lessonName: sanitizePromptInput(lesson.name),
    lessonDescription: sanitizePromptInput(lesson.description),
    moduleName: sanitizePromptInput(mod.name),
  };
};
