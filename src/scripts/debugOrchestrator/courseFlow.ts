import OpenAI from 'openai';
import type { ApiClient } from './apiClient';
import { MarkdownRecorder } from './markdownRecorder';
import type {
  Persona,
  PersonaRun,
  StepResult,
  OrchestratorConfig,
  ClarifyQuestion,
  DepthPreviews,
  CourseStructure,
  CourseData,
} from './types';

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

// ── Helpers ───────────────────────────────────────────────

function timedStep(step: number, name: string) {
  const startedAt = new Date();
  return {
    finish(notes?: string): StepResult {
      const completedAt = new Date();
      return {
        step,
        name,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        notes,
      };
    },
  };
}

async function aiJsonCall<T>(systemPrompt: string, userPrompt: string): Promise<{ result: T; raw: string }> {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
  });

  const raw = response.choices[0]?.message?.content ?? '';
  return { result: JSON.parse(raw) as T, raw };
}

// ── AI-as-Persona functions ─────────────────────────────

function personaContext(persona: Persona): string {
  return `You ARE ${persona.name}. Not role-playing — you ARE this person.

WHO YOU ARE:
${persona.background}

YOUR PERSONALITY:
${persona.personality}

WHAT YOU CARE ABOUT:
${persona.priorities}`;
}

async function answerQuestionsAsPersona(
  persona: Persona,
  questions: ClarifyQuestion[],
): Promise<{ answers: Record<string, unknown>; reasoning: string }> {
  const systemPrompt = `${personaContext(persona)}

YOUR SPECIFIC SURVEY BEHAVIOR:
${persona.wizardBehavior.surveyStyle}

You're filling out a course creation survey. Follow your behavioral description above EXACTLY — it tells you specifically how you handle surveys (how carefully you read, how many options you select, how you write text answers).

Key realism rules:
- SURVEY FATIGUE: You give the first 1-2 questions the most attention. By question 4-5, you're going faster and caring less. Your answers should visibly decline in thoughtfulness as the question number increases.
- POSITION BIAS: On multiple_choice, you're slightly more likely to pick options near the top of the list unless another option clearly jumps out. You don't systematically read and evaluate every option — you stop at the first one that seems right.
- TEXT ANSWERS: Match your communication style exactly. If you're casual, write casual ("yeah mostly just building stuff for fun"). If you're minimal, write minimal ("work project"). Don't perform eloquence you wouldn't actually have.
- SELF-ASSESSMENT ERRORS: If your background says you're a beginner who thinks they're intermediate, pick the intermediate option. If you're experienced but humble, pick the conservative option. Answer based on SELF-PERCEPTION, not objective reality.

FORMAT (strict — the API will reject malformed answers):
- "multiple_choice": return the EXACT text of ONE option (must be a character-perfect match from the options list)
- "multiple_select": return an array of EXACT option texts (character-perfect matches)
- "text": return a string in your voice

Return JSON:
- "answers": { "q1": <answer>, "q2": <answer>, ... }
- "reasoning": 1-2 sentences describing your actual behavior (e.g. "Rushed through the last two questions, picked too many options on q3 because everything sounded relevant")`;

  const { result } = await aiJsonCall<{ answers: Record<string, unknown>; reasoning: string }>(
    systemPrompt,
    JSON.stringify(questions, null, 2),
  );

  return result;
}

async function selectDepthAsPersona(
  persona: Persona,
  depthPreviews: DepthPreviews,
): Promise<{ depth: 'overview' | 'comprehensive' | 'deep_dive'; reasoning: string }> {
  const systemPrompt = `${personaContext(persona)}

YOUR SPECIFIC DEPTH-SELECTION BEHAVIOR:
${persona.wizardBehavior.depthChoice}

You see three depth options (Overview, Comprehensive, Deep Dive) with descriptions, and one is marked "Recommended." Follow your behavioral description above — it tells you exactly how you'd make this choice.

The "Recommended" badge is a POWERFUL UI element. In usability studies, 70-80% of users pick whatever is recommended. Only deviate if your behavioral description specifically says you would.

Return JSON:
- "depth": one of "overview", "comprehensive", or "deep_dive"
- "reasoning": 1 sentence — the REAL reason, not a rationalization. (e.g. "Just picked recommended, didn't really read the others" or "Went with deep_dive because I always want the most complete version of everything")`;

  const { result } = await aiJsonCall<{ depth: 'overview' | 'comprehensive' | 'deep_dive'; reasoning: string }>(
    systemPrompt,
    JSON.stringify(depthPreviews, null, 2),
  );

  return result;
}

async function reviewStructureAsPersona(
  persona: Persona,
  structure: CourseStructure,
): Promise<{ satisfied: boolean; feedback: string }> {
  const systemPrompt = `${personaContext(persona)}

YOUR SPECIFIC STRUCTURE REVIEW BEHAVIOR:
${persona.wizardBehavior.structureReview}

You're looking at a generated course structure (modules and lessons). Follow your behavioral description above — it tells you exactly whether you'd accept or give feedback, and what kind.

Realism calibration:
- Most users (75-80%) accept the structure without feedback. Only give feedback if your behavioral description says you would.
- If you give feedback, write it as a CHAT MESSAGE — casual, short, typed quickly. 1 sentence is normal. 2 sentences is a lot. Nobody writes a paragraph in a chat box.
- Your feedback should be in YOUR voice. A casual person writes "maybe add something about testing?" A formal person writes "I'd like to see a module dedicated to unit testing practices." A frustrated person writes "where's the testing section??"
- Don't be constructive for the sake of being constructive. If your behavioral description says you accept without reading, then accept. Don't force-generate feedback.

Return JSON:
- "satisfied": boolean
- "feedback": your chat message if not satisfied, empty string if satisfied`;

  const { result } = await aiJsonCall<{ satisfied: boolean; feedback: string }>(
    systemPrompt,
    JSON.stringify(structure, null, 2),
  );

  return result;
}

// ── Main Pipeline ────────────────────────────────────────

export async function runPersonaFlow(
  persona: Persona,
  client: ApiClient,
  recorder: MarkdownRecorder,
  config: OrchestratorConfig,
  label: string,
): Promise<PersonaRun> {
  const log = (msg: string) => console.log(`[${label}]`.cyan + ` ${msg}`);
  const logDone = (msg: string) => console.log(`[${label}]`.cyan + ` ${msg}`.green);
  const logDetail = (msg: string) => console.log(`[${label}]`.cyan + ` ${msg}`.gray);
  const flowStart = Date.now();
  const steps: StepResult[] = [];
  let courseId = '';
  let course: CourseData | null = null;

  recorder.setPersona(persona);
  recorder.addHeader();

  try {
    // ── Step 1: Create Course ────────────────────────────
    log('Step 1: Creating course...');
    const s1 = timedStep(1, 'Create Course');
    courseId = await client.createCourse(persona.goal);
    const r1 = s1.finish();
    steps.push(r1);
    recorder.setCourseId(courseId);
    recorder.addStep1_CreateCourse(r1, courseId);
    logDone(`Step 1 done → courseId: ${courseId}`);

    // ── Step 2: Clarify (Question Generation) ───────────
    log('Step 2: Generating clarify questions...');
    const s2 = timedStep(2, 'Clarify Questions');
    const pollStart2 = Date.now();
    const clarifyJobId = await client.submitJob(courseId, 'clarify');
    await client.pollJob(clarifyJobId);
    const pollDuration2 = Date.now() - pollStart2;
    course = await client.getCourse(courseId);
    const questions = (course.clarifyData?.questions ?? []) as ClarifyQuestion[];
    const r2 = s2.finish(`${questions.length} questions generated`);
    steps.push(r2);
    recorder.addStep2_Clarify(r2, questions, pollDuration2);
    logDone(`Step 2 done → ${questions.length} questions`);

    // ── Step 3: Answer Questions (AI as Persona) ────────
    log('Step 3: Answering questions as persona...');
    const s3 = timedStep(3, 'Answer Questions');
    const { answers, reasoning: answerReasoning } = await answerQuestionsAsPersona(persona, questions);
    await client.updateCourse(courseId, { answers });
    const r3 = s3.finish(answerReasoning);
    steps.push(r3);
    recorder.addStep3_Answers(r3, answers, questions, answerReasoning);
    logDone('Step 3 done → answers submitted');

    // ── Step 4: Depth Previews ──────────────────────────
    log('Step 4: Generating depth previews...');
    const s4 = timedStep(4, 'Depth Previews');
    const pollStart4 = Date.now();
    const depthJobId = await client.submitJob(courseId, 'depth-previews');
    await client.pollJob(depthJobId);
    const pollDuration4 = Date.now() - pollStart4;
    course = await client.getCourse(courseId);
    const depthPreviews = course.depthPreviews!;
    const r4 = s4.finish(`recommended: ${depthPreviews.recommended}`);
    steps.push(r4);
    recorder.addStep4_DepthPreviews(r4, depthPreviews, pollDuration4);
    logDone(`Step 4 done → recommended: ${depthPreviews.recommended}`);

    // ── Step 5: Select Depth (AI as Persona) ────────────
    log('Step 5: Selecting depth as persona...');
    const s5 = timedStep(5, 'Select Depth');
    const { depth, reasoning: depthReasoning } = await selectDepthAsPersona(persona, depthPreviews);
    await client.updateCourse(courseId, { depth });
    const r5 = s5.finish(depthReasoning);
    steps.push(r5);
    recorder.addStep5_DepthSelection(r5, depth, depthPreviews.recommended, depthReasoning);
    logDone(`Step 5 done → selected: ${depth}` + (depth !== depthPreviews.recommended ? ` (recommended: ${depthPreviews.recommended})`.yellow : ` (recommended: ${depthPreviews.recommended})`));

    // ── Step 6: Generate Structure ──────────────────────
    log('Step 6: Generating course structure...');
    const s6 = timedStep(6, 'Generate Structure');
    const pollStart6 = Date.now();
    const structJobId = await client.submitJob(courseId, 'generate-structure');
    await client.pollJob(structJobId);
    const pollDuration6 = Date.now() - pollStart6;
    course = await client.getCourse(courseId);
    const structure = course.structure!;
    const totalLessons = structure.modules.reduce((sum, m) => sum + m.lessons.length, 0);
    const r6 = s6.finish(`${structure.modules.length} modules, ${totalLessons} lessons`);
    steps.push(r6);
    recorder.addStep6_Structure(r6, structure, pollDuration6);
    logDone(`Step 6 done → ${structure.modules.length} modules, ${totalLessons} lessons`);

    // ── Step 7: Review Structure (AI as Persona) ────────
    log('Step 7: Reviewing structure...');
    const s7 = timedStep(7, 'Review Structure');
    let feedback: string | null = null;
    let chatResponse: string | null = null;
    let structureChanged = false;

    if (config.enableChatReview) {
      const review = await reviewStructureAsPersona(persona, structure);

      if (!review.satisfied && review.feedback) {
        feedback = review.feedback;
        logDetail(`Step 7: Sending feedback: "${feedback}"`);

        const structureBefore = JSON.stringify(course.structure?.modules);
        chatResponse = await client.postSSE(`/api/course/${courseId}/chat`, {
          messages: [{ role: 'user', content: feedback }],
        });

        // Wait a moment for structure update to settle, then refetch
        await new Promise((r) => setTimeout(r, 2000));
        course = await client.getCourse(courseId);
        structureChanged = JSON.stringify(course.structure?.modules) !== structureBefore;
      } else {
        logDetail('Step 7: Persona satisfied with structure');
      }
    } else {
      logDetail('Step 7: Chat review disabled, skipping');
    }

    const r7 = s7.finish(feedback ? `Feedback: ${feedback}` : 'Accepted as-is');
    steps.push(r7);
    recorder.addStep7_Review(r7, feedback, chatResponse, structureChanged);
    logDone(`Step 7 done → ${feedback ? `feedback sent, structure ${structureChanged ? 'changed'.green : 'unchanged'.yellow}` : 'accepted as-is'}`);

    // ── Step 8: Accept Course ───────────────────────────
    log('Step 8: Accepting course...');
    const s8 = timedStep(8, 'Accept Course');
    await client.updateCourse(courseId, { status: 'ready' });
    course = await client.getCourse(courseId);
    const r8 = s8.finish();
    steps.push(r8);
    recorder.addStep8_Accept(r8);
    logDone('Step 8 done → course accepted');

    // ── Write report ────────────────────────────────────
    const totalDurationMs = Date.now() - flowStart;
    recorder.addSummary(totalDurationMs, course, 'completed');
    const filepath = await recorder.writeToFile(config.outputDir);
    logDetail(`Report written → ${filepath}`);

    return {
      persona,
      courseId,
      steps,
      totalDurationMs,
      status: 'completed',
    };
  } catch (error) {
    const totalDurationMs = Date.now() - flowStart;
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`[${label}]`.cyan + ` FAILED at step ${steps.length + 1}: ${errorMsg}`.red);

    // Write partial report
    if (course || courseId) {
      try {
        if (!course && courseId) course = await client.getCourse(courseId);
      } catch {
        // can't fetch course, use what we have
      }
      if (course) {
        recorder.addSummary(totalDurationMs, course, 'failed', errorMsg);
      }
    }
    try {
      await recorder.writeToFile(config.outputDir);
    } catch {
      // ignore write errors on failure path
    }

    return {
      persona,
      courseId,
      steps,
      totalDurationMs,
      status: 'failed',
      error: errorMsg,
    };
  }
}
