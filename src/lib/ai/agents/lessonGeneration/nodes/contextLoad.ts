import { RunnableConfig } from '@langchain/core/runnables';
import { sanitizePromptInput } from '@lib/sanitize';
import { LessonState } from '../state';

const formatAnswers = (answers: { questionId: string; answer: string }[]) =>
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
  const { answers, depth, structure, moduleIndex, lessonIndex } = state;
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
Course depth: ${depth}

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

  console.log(`[contextLoad] ✓ Built prompts for "${lesson.name}"`.green);

  return {
    humanMessage,
    lessonName: lesson.name,
    lessonDescription: lesson.description,
    moduleName: mod.name,
  };
};
