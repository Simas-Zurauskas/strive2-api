import { sanitizePromptInput } from '@lib/sanitize';
import LessonContentModel from '@models/LessonContentModel';
import { QuizState } from '../state';

const formatAnswers = (answers: { questionId: string; answer: string }[]) =>
  answers.map((a) => `- ${a.questionId}: ${sanitizePromptInput(a.answer)}`).join('\n');

export const contextLoad = async (state: QuizState): Promise<Partial<QuizState>> => {
  const { answers, depth, structure, moduleIndex } = state;
  const goal = sanitizePromptInput(state.goal);

  const mod = structure.modules[moduleIndex];

  // Load all lesson summaries for this module
  const lessonDocs = await LessonContentModel.find({
    courseId: state.courseId,
    moduleIndex,
  })
    .select('lessonIndex summary')
    .sort({ lessonIndex: 1 })
    .lean();

  const lessonSummaries = mod.lessons.map((lesson, li) => {
    const doc = lessonDocs.find((d) => d.lessonIndex === li);
    return `### Lesson ${li + 1}: ${lesson.name}\n${lesson.description}\n${doc?.summary ? `Summary: ${doc.summary}` : '(no summary available)'}`;
  });

  // Load previous module summaries for interleaving (if not first module)
  let interleavingContext = '';
  if (moduleIndex > 0) {
    const prevModuleIndex = moduleIndex - 1;
    const prevMod = structure.modules[prevModuleIndex];
    const prevDocs = await LessonContentModel.find({
      courseId: state.courseId,
      moduleIndex: prevModuleIndex,
    })
      .select('lessonIndex summary')
      .sort({ lessonIndex: 1 })
      .lean();

    const prevSummaries = prevMod.lessons.map((lesson, li) => {
      const doc = prevDocs.find((d) => d.lessonIndex === li);
      return `- Lesson ${li + 1}: ${lesson.name} — ${doc?.summary ?? lesson.description}`;
    });

    interleavingContext = `## Previous module for interleaved review questions

Module ${prevModuleIndex + 1}: ${prevMod.name}
${prevSummaries.join('\n')}

Include 1-2 review questions from this previous module. Set isInterleaved=true and interleavedModuleIndex=${prevModuleIndex} for these.`;
  }

  const humanMessage = `## Course context

Learning goal: ${goal}
Course depth: ${depth}

Learner's answers to clarifying questions:
${formatAnswers(answers)}

## Module to assess

Module ${moduleIndex + 1}: ${mod.name}
${mod.description}

## Lesson summaries

${lessonSummaries.join('\n\n')}

${interleavingContext}

Generate 5-8 quiz questions that test synthesis and application across the lessons in this module.`;

  console.log(`[quizContextLoad] ✓ Built prompts for module "${mod.name}" (${lessonDocs.length} lessons loaded)`.green);

  return {
    moduleName: mod.name,
    humanMessage,
  };
};
