import { sanitizePromptInput } from '@lib/sanitize';
import LessonContentModel from '@models/LessonContentModel';
import { genLog } from '@lib/loggers';
import { QuizState } from '../state';

const formatAnswers = (answers: { questionId: string; answer: string }[]) =>
  answers.map((a) => `- ${a.questionId}: ${sanitizePromptInput(a.answer)}`).join('\n');

export const contextLoad = async (state: QuizState): Promise<Partial<QuizState>> => {
  const { answers, depth, domain, structure, moduleIndex } = state;
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

  // Quiz only what exists. The module may be partially generated (the gate
  // requires ≥2 generated lessons, not all) — ungenerated lessons are
  // excluded entirely rather than padded with "(no summary available)",
  // which used to invite questions about content the learner has never
  // seen. Lesson numbering stays outline-based so the quiz can reference
  // "Lesson 3" consistently with the sidebar.
  const generatedLessonIndexes = new Set(lessonDocs.map((d) => d.lessonIndex));
  const lessonSummaries = mod.lessons
    .map((lesson, li) => {
      if (!generatedLessonIndexes.has(li)) return null;
      const doc = lessonDocs.find((d) => d.lessonIndex === li);
      return `### Lesson ${li + 1}: ${lesson.name}\n${lesson.description}\n${doc?.summary ? `Summary: ${doc.summary}` : ''}`;
    })
    .filter((s): s is string => s !== null);
  const partialModule = generatedLessonIndexes.size < mod.lessons.length;

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

    // Same generated-only rule as the main module: review questions must
    // come from lessons the learner has actually seen. If nothing in the
    // previous module was generated, skip interleaving entirely.
    const prevGenerated = new Set(prevDocs.map((d) => d.lessonIndex));
    const prevSummaries = prevMod.lessons
      .map((lesson, li) => {
        if (!prevGenerated.has(li)) return null;
        const doc = prevDocs.find((d) => d.lessonIndex === li);
        return `- Lesson ${li + 1}: ${lesson.name} — ${doc?.summary ?? lesson.description}`;
      })
      .filter((s): s is string => s !== null);

    if (prevSummaries.length > 0) {
      interleavingContext = `## Previous module for interleaved review questions

Module ${prevModuleIndex + 1}: ${prevMod.name}
${prevSummaries.join('\n')}

Include 1-2 review questions from this previous module. Set isInterleaved=true and interleavedModuleIndex=${prevModuleIndex} for these.`;
    }
  }

  const humanMessage = `## Course context

Learning goal: ${goal}
Course depth: ${depth}${domain ? `\nCourse domain: ${domain}` : ''}

Learner's answers to clarifying questions:
${formatAnswers(answers)}

## Module to assess

Module ${moduleIndex + 1}: ${mod.name}
${mod.description}

## Lesson summaries

${lessonSummaries.join('\n\n')}

${interleavingContext}

${partialModule ? `The learner has generated ${generatedLessonIndexes.size} of ${mod.lessons.length} lessons in this module so far. Quiz ONLY the lessons listed above — never reference or assume content from lessons that are not listed.\n\n` : ''}Generate 5-8 quiz questions that test synthesis and application across the lessons in this module.`;

  genLog.info(`quiz:context-load module=${moduleIndex} name="${mod.name}" lessons=${lessonDocs.length}`);

  return {
    moduleName: mod.name,
    humanMessage,
  };
};
