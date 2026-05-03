import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { ApiClient } from './apiClient';
import { LESSON_POLL_TIMEOUT_MS, WITH_RETRY_POLL_TIMEOUT_MS } from './apiClient';
import { MarkdownRecorder } from './markdownRecorder';
import { withRetry } from '@lib/retry';
import { MODEL_IDS } from '@lib/langchain';
import { makeLlmCacheCallback } from '@lib/ai/cacheLogger';
import { ANTHROPIC_API_KEY } from '@conf/env';
import { COURSE_DEPTHS, type CourseDepth } from '@lib/constants';
import type {
  Persona,
  PersonaRun,
  StepResult,
  OrchestratorConfig,
  ClarifyQuestion,
  DepthPreviews,
  CourseStructure,
  CourseData,
  ILessonContent,
  LessonContentStats,
  ModuleQuizForLearner,
  ModuleQuizQuestionForLearner,
  ModuleQuizAttemptRecord,
  QuizNoiseTrace,
  InsightReviewResult,
  CourseMentorRecord,
  LessonMentorRecord,
  MentorTurn,
  GoalTypeClassificationSnapshot,
  GoalTypeOverrideRecord,
} from './types';
import type { GetInsightQueueResult, QueueInsightItem, InsightStats } from '@services/insightQueueService';
import type { InsightMode, InsightRating } from '@lib/insightConstants';
import { createPrng } from './prng';
import { applyQuizNoise, computeSimulatedThinkTimeMs } from './quizNoise';

// Dedicated Sonnet instance at temp 0.7 for persona-simulation reasoning.
// Not the shared `utilityModel` (Haiku, temp 0) because the orchestrator
// simulates realistic users — cheap/cold Haiku flattens the behavioral
// variance the prompts are calibrated to elicit.
let _model: ChatAnthropic | null = null;
function getOrchestratorModel(): ChatAnthropic {
  if (!_model) {
    _model = new ChatAnthropic({
      model: MODEL_IDS.SONNET,
      temperature: 0.7,
      anthropicApiKey: ANTHROPIC_API_KEY,
      maxTokens: 8192,
      clientOptions: { timeout: 120000 },
      callbacks: [makeLlmCacheCallback({ defaultLabel: 'orchestrator:flow', model: MODEL_IDS.SONNET })],
    });
  }
  return _model;
}

// ── Helpers ───────────────────────────────────────────────

function timedStep({ step, name }: { step: number; name: string }) {
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

/**
 * Structured-output wrapper around the orchestrator's Sonnet client.
 * LangChain's `withStructuredOutput` uses Anthropic tool-use under the hood
 * to enforce the schema, so a mismatch raises a typed error that
 * `withRetry` sees — no hand-rolled JSON-mode + zod parse step needed.
 */
async function aiJsonCall<T>({
  systemPrompt,
  userPrompt,
  schema,
  label,
}: {
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  label: string;
}): Promise<{ result: T }> {
  const model = getOrchestratorModel().withStructuredOutput(schema);
  const result = await model.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)], {
    metadata: { llmLabel: label },
  });
  return { result: result as T };
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

const answerQuestionsOutputSchema = z.object({
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  reasoning: z.string(),
});

async function answerQuestionsAsPersona({
  persona,
  questions,
}: {
  persona: Persona;
  questions: ClarifyQuestion[];
}): Promise<{ answers: Record<string, unknown>; reasoning: string }> {
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

  const { result } = await aiJsonCall({
    systemPrompt,
    userPrompt: JSON.stringify(questions, null, 2),
    schema: answerQuestionsOutputSchema,
    label: 'orchestrator:answer-questions',
  });

  return result;
}

const selectDepthOutputSchema = z.object({
  depth: z.enum(COURSE_DEPTHS),
  reasoning: z.string(),
});

async function selectDepthAsPersona({
  persona,
  depthPreviews,
}: {
  persona: Persona;
  depthPreviews: DepthPreviews;
}): Promise<{ depth: CourseDepth; reasoning: string }> {
  const systemPrompt = `${personaContext(persona)}

YOUR SPECIFIC DEPTH-SELECTION BEHAVIOR:
${persona.wizardBehavior.depthChoice}

You see three depth options (Overview, Comprehensive, Deep Dive) with descriptions, and one is marked "Recommended." Follow your behavioral description above — it tells you exactly how you'd make this choice.

The "Recommended" badge is a POWERFUL UI element. In usability studies, 70-80% of users pick whatever is recommended. Only deviate if your behavioral description specifically says you would.

Return JSON:
- "depth": EXACTLY one of these lowercase strings: "overview", "comprehensive", or "deep_dive". No other values, no capitalization, no synonyms — the API rejects anything else.
- "reasoning": 1 sentence — the REAL reason, not a rationalization. (e.g. "Just picked recommended, didn't really read the others" or "Went with deep_dive because I always want the most complete version of everything")`;

  const userPrompt = JSON.stringify(depthPreviews, null, 2);

  // withRetry (3 retries, exponential backoff) catches schema-mismatch
  // failures from `aiJsonCall` — same pattern the prod LangChain calls use.
  // When all retries exhaust, fall back to depthPreviews.recommended so the
  // orchestrator run still produces a report. The fallback marker is in
  // the reasoning string so it shows up in the persona's step notes and
  // is greppable across run outputs.
  try {
    const { result } = await withRetry(() =>
      aiJsonCall({ systemPrompt, userPrompt, schema: selectDepthOutputSchema, label: 'orchestrator:select-depth' }),
    );
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const recommended = depthPreviews.recommended as CourseDepth;
    console.warn(
      `[selectDepthAsPersona] All retries exhausted, falling back to recommended depth (${recommended}). Cause: ${reason}`
        .yellow,
    );
    return {
      depth: recommended,
      reasoning: `[fallback] LLM produced invalid output across all retries; defaulted to recommended (${recommended}). Cause: ${reason}`,
    };
  }
}

const reviewStructureOutputSchema = z.object({
  satisfied: z.boolean(),
  feedback: z.string(),
});

async function reviewStructureAsPersona({
  persona,
  structure,
}: {
  persona: Persona;
  structure: CourseStructure;
}): Promise<{ satisfied: boolean; feedback: string }> {
  // Invoked only when the orchestrator was launched with --chat. Under
  // realistic calibration (~20% feedback) the chat path almost never
  // actually fires in a 2-persona run, so the report never exercises
  // refine_structure. Flip the bias: the caller *asked* to test the chat
  // path, so generate feedback by default unless the persona is clearly
  // a fast-accepter.
  const systemPrompt = `${personaContext(persona)}

YOUR SPECIFIC STRUCTURE REVIEW BEHAVIOR:
${persona.wizardBehavior.structureReview}

You're looking at a generated course structure (modules and lessons). Follow your behavioral description above — it tells you what kind of feedback you'd give.

DEBUG CONTEXT: the orchestrator explicitly opted into chat review to exercise the refine-structure flow. Unless your behavioral description says you accept structures without reading, default to giving at least one piece of concrete feedback on content, ordering, missing topics, or depth. A realistic-but-active reviewer is what we want here.

Calibration:
- If your behavioral description says you skim/accept-on-trust, it is OK to return satisfied=true. Otherwise, find something genuine to push on.
- Write feedback as a CHAT MESSAGE — casual, short, 1-2 sentences. Not a paragraph.
- Use your voice. Casual: "maybe add something about testing?" Formal: "I'd like a dedicated module on unit testing." Frustrated: "where's the testing section??"
- Do not invent topics outside your expressed goals. Feedback must be grounded in what you'd actually care about as this persona.

Return JSON:
- "satisfied": boolean
- "feedback": your chat message if not satisfied, empty string if satisfied`;

  const { result } = await aiJsonCall({
    systemPrompt,
    userPrompt: JSON.stringify(structure, null, 2),
    schema: reviewStructureOutputSchema,
    label: 'orchestrator:review-structure',
  });

  return result;
}

/**
 * Baseline answer from the LLM — pre-noise. Confidence is the LLM's self-
 * reported certainty per question; the post-LLM noise injector uses it to
 * decide when the persona's style flags kick in (low confidence → guessing
 * personas swap; high confidence → second-guessing personas flip).
 */
interface LlmQuizResponse {
  questionId: string;
  selectedOption: number;
  confidence: number;
}

/**
 * Shape-only validation. Bounds (selectedOption ∈ [0, 3], confidence ∈
 * [0, 1]) are NOT enforced here because the consumer downstream already
 * defends per-item via `responseById.get(...)?.selectedOption ?? 0` and
 * a typeof-check on confidence. Schema is just enough to catch a
 * categorically broken payload (responses missing, reasoning missing,
 * not an array) so withRetry has something to react to.
 */
const quizAnswerOutputSchema = z.object({
  responses: z.array(
    z
      .object({
        questionId: z.string(),
        selectedOption: z.number(),
        confidence: z.number(),
      })
      .passthrough(),
  ),
  reasoning: z.string(),
});

const insightTapRevealOutputSchema = z.object({
  rating: z.number(),
  reasoning: z.string(),
});

const insightTypedRecallOutputSchema = z.object({
  userAnswer: z.string(),
  reasoning: z.string(),
});

async function answerQuizAsPersona({
  persona,
  moduleName,
  questions,
  runId,
  personaSlug,
}: {
  persona: Persona;
  moduleName: string;
  questions: ModuleQuizQuestionForLearner[];
  runId: string;
  personaSlug: string;
}): Promise<{
  responses: { questionId: string; selectedOption: number }[];
  reasoning: string;
  simulatedSubmissionMs: number;
  llmLatencyMs: number;
  noiseTrace: QuizNoiseTrace[];
}> {
  const systemPrompt = `${personaContext(persona)}

YOUR SPECIFIC QUIZ-TAKING BEHAVIOR:
${persona.wizardBehavior.quizAttemptStyle}

You're taking a multiple-choice module quiz at the end of "${moduleName}". Each question has exactly 4 options (indices 0–3). Follow your behavioral description above — it tells you how carefully to read, whether to eliminate options, whether to second-guess, whether position bias dominates.

Realism rules:
- QUIZ FATIGUE: Attention drops after the first 2–3 questions. Rushers rush harder later. Careful readers may slow down but still skim.
- POSITION BIAS: Unless your style says otherwise, option A (index 0) is slightly more likely to be picked when you're unsure.
- SECOND-GUESSING: Only flip answers if your style explicitly mentions overthinking.
- You do NOT see the correct answer. Pick based on the question text + your implicit knowledge of the topic + your style.
- CONFIDENCE: Report an honest confidence score per question (0.0–1.0). Low confidence on items where the lesson content is hazy for this persona; high confidence on items where the persona would feel certain. Do NOT make everything 1.0 — that's not how real humans feel while taking a quiz.

FORMAT (strict — selectedOption must be 0..3; confidence must be a number in [0, 1]):
Return JSON:
- "responses": [{ "questionId": "<id>", "selectedOption": <0..3>, "confidence": <0.0-1.0> }, ...] (one entry per question, in order)
- "reasoning": 1–2 sentences describing your actual behavior (e.g. "Rushed the last two; picked option A on q3 because I wasn't sure")`;

  const llmStart = Date.now();
  const { result } = await withRetry(() =>
    aiJsonCall({
      systemPrompt,
      userPrompt: JSON.stringify(questions, null, 2),
      schema: quizAnswerOutputSchema,
      label: 'orchestrator:answer-quiz',
    }),
  );
  const llmLatencyMs = Date.now() - llmStart;

  // Build a lookup so malformed LLM output (missing/duplicate questionIds)
  // still lands on a safe fallback per question.
  const responseById = new Map<string, LlmQuizResponse>();
  for (const r of result.responses ?? []) {
    if (r && typeof r.questionId === 'string') responseById.set(r.questionId, r);
  }

  const noiseTrace: QuizNoiseTrace[] = [];
  const responses: { questionId: string; selectedOption: number }[] = [];

  for (const q of questions) {
    const llmResponse = responseById.get(q.id);
    const llmPick = llmResponse?.selectedOption ?? 0;
    const confidence = typeof llmResponse?.confidence === 'number' ? llmResponse.confidence : 0.5;

    // Seed per (runId, personaSlug, questionId) so reruns are byte-identical.
    const prng = createPrng(`${runId}:${personaSlug}:${q.id}`);
    const { finalOption, trace } = applyQuizNoise({
      questionId: q.id,
      questionText: q.question,
      optionCount: q.options.length,
      llmPick,
      confidence,
      flags: persona.quizStyleFlags,
      prng,
    });
    responses.push({ questionId: q.id, selectedOption: finalOption });
    noiseTrace.push(trace);
  }

  // Simulated think-time (replaces wall-clock LLM latency as the reported
  // "Submission time"). Seeded PRNG keyed on the whole quiz, so jitter is
  // deterministic per (runId, personaSlug, moduleName).
  const thinkTimePrng = createPrng(`${runId}:${personaSlug}:${moduleName}:think-time`);
  const simulatedSubmissionMs = computeSimulatedThinkTimeMs({
    questions: questions.map((q) => ({ questionText: q.question })),
    flags: persona.quizStyleFlags,
    prng: thinkTimePrng,
  });

  return {
    responses,
    reasoning: result.reasoning,
    simulatedSubmissionMs,
    llmLatencyMs,
    noiseTrace,
  };
}

async function reviewInsightTapReveal({
  persona,
  insight,
  runId,
  personaSlug,
}: {
  persona: Persona;
  insight: QueueInsightItem;
  runId: string;
  personaSlug: string;
}): Promise<{ rating: InsightRating; reasoning: string }> {
  const systemPrompt = `${personaContext(persona)}

YOUR SPECIFIC INSIGHT-REVIEW BEHAVIOR:
${persona.wizardBehavior.insightReviewStyle}

You're reviewing a retrieval-practice card in TAP-REVEAL mode: you see the prompt, then the answer, then rate how well you remembered it.

Rating scale (Anki-style):
- 1 = Again   — didn't remember at all, or got it wrong
- 2 = Hard    — remembered with difficulty / partially
- 3 = Good    — remembered correctly with normal effort
- 4 = Easy    — remembered instantly, obvious

Rate HONESTLY per your style:
- "generous" → skews toward 3/4 even when hazy
- "harsh" → skews toward 1/2 even when mostly correct
- "honest" → realistic distribution
Realism: most adults don't instantly recall new material; 4 should be rare on a first review.

Return JSON:
- "rating": 1 | 2 | 3 | 4
- "reasoning": 1 short sentence (e.g. "Recognized the concept but would've fumbled the exact wording — Hard")`;

  const userPrompt = `PROMPT (${insight.kind}):\n${insight.prompt}\n\nCANONICAL ANSWER:\n${insight.answer}`;

  const { result } = await withRetry(() =>
    aiJsonCall({
      systemPrompt,
      userPrompt,
      schema: insightTapRevealOutputSchema,
      label: 'orchestrator:insight-tap-reveal',
    }),
  );

  let rating = clampRating(result.rating);
  // Apply tap-reveal rating bias driven by the persona's insight style
  // flags. The prompt already instructs the LLM to skew, but the LLM
  // tends to anchor around the middle (2-3) regardless of instruction;
  // the seeded bias nudges the distribution without overriding obvious
  // cases. Keyed on insightId so reruns produce identical ratings.
  const prng = createPrng(`${runId}:${personaSlug}:${insight.insightId}:tap-reveal-bias`);
  if (persona.insightStyleFlags.generous && rating < 4 && prng.nextBool(0.4)) {
    rating = (rating + 1) as InsightRating;
  } else if (persona.insightStyleFlags.harsh && rating > 1 && prng.nextBool(0.4)) {
    rating = (rating - 1) as InsightRating;
  }
  return { rating, reasoning: result.reasoning };
}

async function reviewInsightTypedRecall({
  persona,
  insight,
  runId,
  personaSlug,
}: {
  persona: Persona;
  insight: QueueInsightItem;
  runId: string;
  personaSlug: string;
}): Promise<{ userAnswer: string; reasoning: string }> {
  const systemPrompt = `${personaContext(persona)}

YOUR SPECIFIC INSIGHT-REVIEW BEHAVIOR:
${persona.wizardBehavior.insightReviewStyle}

You're reviewing a retrieval-practice card in TYPED-RECALL mode: you see only the prompt and type your best answer. You do NOT see the canonical answer. The server will grade your answer.

Realism rules:
- Type in YOUR voice. Casual personas type casually; precise personas type concisely.
- Partial recall is normal — if you only remember a piece, type that piece. Don't make up details.
- For cloze items (the prompt contains "{{blank}}"), type ONLY the fill — nothing else.
- For Q&A items, type one concise sentence or phrase. Long paragraphs are not realistic.
- Don't write "I don't know" unless your style describes someone who'd actually type that.

Return JSON:
- "userAnswer": your typed answer as a string (1–200 chars; empty string is rare but allowed)
- "reasoning": 1 short sentence (e.g. "Pretty sure this is about decorators, typed a rough guess")`;

  const userPrompt = `PROMPT (${insight.kind}):\n${insight.prompt}`;

  const { result } = await withRetry(() =>
    aiJsonCall({
      systemPrompt,
      userPrompt,
      schema: insightTypedRecallOutputSchema,
      label: 'orchestrator:insight-typed-recall',
    }),
  );

  // If the persona's insight style flags indicate they struggle to articulate,
  // degrade the LLM's polished canonical-quality answer into something closer
  // to partial human recall. This restores realism for the grading rubric:
  // without it, Haiku (temp 0, sees canonical answer) grades every typed
  // recall as ≥0.85 "correct", destroying the distribution. The degrader is
  // seeded per (runId, personaSlug, insightId) so reruns are byte-identical.
  if (persona.insightStyleFlags.struggles && result.userAnswer) {
    const prng = createPrng(`${runId}:${personaSlug}:${insight.insightId}:typed-degrade`);
    result.userAnswer = degradeTypedRecallAnswer({ answer: result.userAnswer, prng });
  }

  return result;
}

/**
 * Degrade a typed-recall answer to resemble realistic partial human recall.
 * Two transformations, each probabilistic:
 *
 *   1. Token-level truncation: keep the first 60-80% of tokens. First and
 *      last tokens always preserved (simulating "remembered the start and
 *      the punchline but fumbled the middle"). Interior tokens dropped at
 *      ~30% rate.
 *
 *   2. Proper-noun dropping: tokens that look like proper nouns (Capitalized
 *      mid-sentence, length ≥ 4) are dropped at ~40% rate. Simulates forgetting
 *      specific library/tool/author names — the most common typed-recall miss.
 *
 * Cap overall drop rate at 30% of original tokens to avoid gutting the answer
 * entirely. The grader (Haiku temp 0 with canonical visibility) will score
 * degraded outputs as "partial" (0.4-0.85) instead of "correct" (≥0.85),
 * restoring a realistic grade distribution.
 */
const degradeTypedRecallAnswer = ({ answer, prng }: { answer: string; prng: import('./prng').Prng }): string => {
  const tokens = answer.split(/\s+/).filter(Boolean);
  if (tokens.length <= 2) return answer; // too short — don't touch

  const maxDrops = Math.floor(tokens.length * 0.3);
  let drops = 0;
  const kept: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const isBoundary = i === 0 || i === tokens.length - 1;
    if (isBoundary) {
      kept.push(t);
      continue;
    }
    if (drops >= maxDrops) {
      kept.push(t);
      continue;
    }
    // Proper-noun-looking token: Capitalized, length ≥ 4, not sentence-start.
    const looksLikeProperNoun = /^[A-Z][a-z]{3,}/.test(t);
    const dropProb = looksLikeProperNoun ? 0.4 : 0.3;
    if (prng.nextBool(dropProb)) {
      drops += 1;
      continue; // drop this token
    }
    kept.push(t);
  }

  return kept.join(' ');
};

function clampRating(raw: number): InsightRating {
  const r = Math.round(raw);
  if (r <= 1) return 1;
  if (r >= 4) return 4;
  return r as InsightRating;
}

function mapGradeToRating(score: number): InsightRating {
  if (score >= 0.9) return 4;
  if (score >= 0.7) return 3;
  if (score >= 0.4) return 2;
  return 1;
}

function pickModeFromPersona({ persona, currentMode }: { persona: Persona; currentMode: InsightMode }): InsightMode {
  const style = persona.wizardBehavior.insightReviewStyle.toLowerCase();
  if (style.includes('typed-recall') || style.includes('type')) return 'typed-recall';
  if (style.includes('tap-reveal') || style.includes('tap') || style.includes('quick')) return 'tap-reveal';
  return currentMode;
}

function shouldSkipInsight({
  persona,
  item,
  alreadySkipped,
}: {
  persona: Persona;
  item: QueueInsightItem;
  alreadySkipped: boolean;
}): boolean {
  if (alreadySkipped) return false;
  const style = persona.wizardBehavior.insightReviewStyle.toLowerCase();
  if (!style.includes('skip')) return false;
  return item.isNew && item.box === 0;
}

// ── Mentor-chat probe generators ─────────────────────────
//
// Each probe is a multi-turn conversation (up to MAX_MENTOR_TURNS)
// driven by an AI-as-persona loop:
//   T1: opening question (persona-context only, no prior turns)
//   T2..N: follow-up decision based on the prior reply (continue or stop)
// The server (chatStream / lessonChat) keeps chat history itself, so per
// turn we only send the new user message and the controller stitches
// prior context. Total cost per probe: 3 mentor calls + 3 persona LLM
// calls (worst case); persona usually stops at 2.

const MAX_MENTOR_TURNS = 3;
const MAX_OPENING_QUESTION_LEN = 400;

interface MentorTurnInput {
  question: string;
  reasoning: string;
}

const openingQuestionSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(MAX_OPENING_QUESTION_LEN)
    .describe('A natural opening question the persona would type into the chat.'),
  reasoning: z.string().describe('Why a learner like this persona would ask this specific question right now.'),
});

const followUpDecisionSchema = z.object({
  decision: z
    .enum(['continue', 'stop'])
    .describe(
      "'continue' if the persona has a meaningful follow-up after the mentor's last reply; 'stop' if their needs are satisfied OR the conversation has stalled.",
    ),
  question: z
    .string()
    .max(MAX_OPENING_QUESTION_LEN)
    .optional()
    .describe('Required when decision=continue. Must reference what the mentor just said.'),
  reasoning: z
    .string()
    .describe(
      'One sentence: why continuing or stopping, and what the persona is hoping to get from this turn (or why they are done).',
    ),
});

function formatPriorTurns(turns: MentorTurnInput[], replies: string[]): string {
  // Render the conversation up to (and including) the most recent mentor
  // reply for the persona-LLM to read. `turns[i]` is what the persona
  // asked; `replies[i]` is what the mentor said in response.
  if (turns.length === 0) return '(no prior turns)';
  const lines: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    lines.push(`Turn ${i + 1} — You: ${turns[i].question}`);
    if (replies[i]) lines.push(`Turn ${i + 1} — Mentor: ${replies[i]}`);
  }
  return lines.join('\n\n');
}

async function openingCourseMentorQuestion({
  persona,
  course,
}: {
  persona: Persona;
  course: CourseData;
}): Promise<MentorTurnInput> {
  const moduleSummary = (course.structure?.modules ?? [])
    .slice(0, 6)
    .map((m, i) => `${i + 1}. ${m.name}${m.description ? ` — ${m.description}` : ''}`)
    .join('\n');

  const userPrompt = `You're about to start the course below. The course-design chat is open — you can ask questions
before diving in. Pick a SPECIFIC opening question YOUR persona would actually type. Bias toward
orientation/clarification rather than structure modification:
  - "What should I read or set up before module 1?"
  - "How long will this realistically take given my constraints?"
  - "Why does module 2 come before module 4 in this order?"
  - "What level of [domain skill] should I have before starting?"
Avoid:
  - generic prompts like "tell me about this course"
  - heavy structure-feedback like "rewrite all of module 3" (that's a different feature)

COURSE
- Name: ${course.name ?? '(unnamed)'}
- Goal: ${persona.goal}
- Domain: ${course.domain ?? 'unspecified'}
- Selected depth: ${course.depth ?? 'unspecified'}

MODULES (first 6):
${moduleSummary || '(none)'}

Return your opening question:`;

  const { result } = await aiJsonCall({
    systemPrompt: personaContext(persona),
    userPrompt,
    schema: openingQuestionSchema,
    label: 'orchestrator:courseMentor:opening',
  });
  return result;
}

async function followUpCourseMentor({
  persona,
  priorTurns,
  priorReplies,
  turnNumber,
}: {
  persona: Persona;
  priorTurns: MentorTurnInput[];
  priorReplies: string[];
  turnNumber: number;
}): Promise<{ decision: 'continue' | 'stop'; question?: string; reasoning: string }> {
  const userPrompt = `You're in turn ${turnNumber} of a conversation with the course-design mentor (max ${MAX_MENTOR_TURNS} turns).

CONVERSATION SO FAR:
${formatPriorTurns(priorTurns, priorReplies)}

Decide whether to ask one more question or stop. Real learners stop when their needs are met — don't
continue just for the sake of it. If continuing, the next question must reference something the mentor
just said (no topic-jumping).`;

  const { result } = await aiJsonCall({
    systemPrompt: personaContext(persona),
    userPrompt,
    schema: followUpDecisionSchema,
    label: 'orchestrator:courseMentor:followUp',
  });
  return result;
}

async function openingLessonMentorQuestion({
  persona,
  moduleName,
  lessonName,
  lessonContent,
}: {
  persona: Persona;
  moduleName: string;
  lessonName: string;
  lessonContent: ILessonContent;
}): Promise<MentorTurnInput> {
  const lessonBody = (lessonContent.blocks ?? [])
    .filter((b) => ['intro', 'section', 'callout', 'summary'].includes(b.type))
    .sort((a, b) => a.order - b.order)
    .map((b) => b.content)
    .join('\n\n')
    .slice(0, 6_000);

  const userPrompt = `You just read the lesson below. The lesson mentor (Socratic AI tutor) is open in a side panel.
Ask ONE opening question this persona would naturally type after reading. Valid shapes:
  - "I'm not sure I get [specific concept] — can you explain it differently?"
  - "How would [lesson concept] apply to [your stated artifact/project]?"
  - "Why does [X] work that way and not [Y]?"
  - "Quiz me on this." (if your persona quizzes themselves)
Avoid:
  - lazy prompts like "summarize this lesson" (the lesson is already in front of you)
  - asking for the answer to the inline quiz/exercise

LESSON
- Module: ${moduleName}
- Lesson: ${lessonName}

CONTENT (truncated):
${lessonBody || '(no body)'}

Return your opening question:`;

  const { result } = await aiJsonCall({
    systemPrompt: personaContext(persona),
    userPrompt,
    schema: openingQuestionSchema,
    label: 'orchestrator:lessonMentor:opening',
  });
  return result;
}

async function followUpLessonMentor({
  persona,
  moduleName,
  lessonName,
  priorTurns,
  priorReplies,
  turnNumber,
}: {
  persona: Persona;
  moduleName: string;
  lessonName: string;
  priorTurns: MentorTurnInput[];
  priorReplies: string[];
  turnNumber: number;
}): Promise<{ decision: 'continue' | 'stop'; question?: string; reasoning: string }> {
  const userPrompt = `You're in turn ${turnNumber} of a conversation with the lesson mentor for "${moduleName} → ${lessonName}" (max ${MAX_MENTOR_TURNS} turns).

CONVERSATION SO FAR:
${formatPriorTurns(priorTurns, priorReplies)}

Decide whether to ask one more question or stop. Real learners stop when they get the clarification they
were after. If continuing, your follow-up must reference what the mentor just said (no topic-jumping)
and stay in scope of THIS lesson.`;

  const { result } = await aiJsonCall({
    systemPrompt: personaContext(persona),
    userPrompt,
    schema: followUpDecisionSchema,
    label: 'orchestrator:lessonMentor:followUp',
  });
  return result;
}

// ── Multi-turn mentor conversation drivers ──────────────
//
// Both drivers follow the same loop:
//   1. Generate the opening question via the persona-LLM.
//   2. Send it to the mentor; capture the SSE reply.
//   3. Ask the persona-LLM whether to continue or stop based on the
//      conversation so far. If continue, repeat from step 2 with the
//      new question. If stop (or cap reached), end.
// Failures inside any turn are recorded on that turn (`error` field) and
// terminate the conversation early — the assessor still sees what we got.

async function runCourseMentorConversation({
  persona,
  course,
  client,
  courseId,
  logDetail,
}: {
  persona: Persona;
  course: CourseData;
  client: ApiClient;
  courseId: string;
  logDetail: (msg: string) => void;
}): Promise<CourseMentorRecord> {
  const turns: MentorTurn[] = [];
  const recordedQuestions: MentorTurnInput[] = [];
  const recordedReplies: string[] = [];
  let endedReason = `hit ${MAX_MENTOR_TURNS}-turn cap`;
  const overallStart = Date.now();

  for (let turnNumber = 1; turnNumber <= MAX_MENTOR_TURNS; turnNumber++) {
    let questionInput: MentorTurnInput;
    try {
      if (turnNumber === 1) {
        questionInput = await openingCourseMentorQuestion({ persona, course });
      } else {
        const decision = await followUpCourseMentor({
          persona,
          priorTurns: recordedQuestions,
          priorReplies: recordedReplies,
          turnNumber,
        });
        if (decision.decision === 'stop' || !decision.question) {
          endedReason = `persona stopped after turn ${turnNumber - 1}: ${decision.reasoning}`;
          break;
        }
        questionInput = { question: decision.question, reasoning: decision.reasoning };
      }
    } catch (e) {
      endedReason = `persona-LLM failed at turn ${turnNumber}: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }

    logDetail(
      `  course-mentor T${turnNumber}: "${questionInput.question.slice(0, 80)}${questionInput.question.length > 80 ? '…' : ''}"`,
    );
    const turnStart = Date.now();
    try {
      const response = await client.chatWithCourseMentor({ courseId, message: questionInput.question });
      turns.push({
        turnNumber,
        question: questionInput.question,
        questionRationale: questionInput.reasoning,
        response,
        durationMs: Date.now() - turnStart,
      });
      recordedQuestions.push(questionInput);
      recordedReplies.push(response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      turns.push({
        turnNumber,
        question: questionInput.question,
        questionRationale: questionInput.reasoning,
        response: '',
        durationMs: Date.now() - turnStart,
        error: msg,
      });
      endedReason = `mentor error at turn ${turnNumber}: ${msg}`;
      break;
    }
  }

  return {
    scope: 'course',
    turns,
    endedReason,
    totalDurationMs: Date.now() - overallStart,
  };
}

async function runLessonMentorConversation({
  persona,
  moduleIndex,
  lessonIndex,
  moduleName,
  lessonName,
  lessonContent,
  client,
  courseId,
  logDetail,
}: {
  persona: Persona;
  moduleIndex: number;
  lessonIndex: number;
  moduleName: string;
  lessonName: string;
  lessonContent: ILessonContent;
  client: ApiClient;
  courseId: string;
  logDetail: (msg: string) => void;
}): Promise<LessonMentorRecord> {
  const turns: MentorTurn[] = [];
  const recordedQuestions: MentorTurnInput[] = [];
  const recordedReplies: string[] = [];
  let endedReason = `hit ${MAX_MENTOR_TURNS}-turn cap`;
  const overallStart = Date.now();

  for (let turnNumber = 1; turnNumber <= MAX_MENTOR_TURNS; turnNumber++) {
    let questionInput: MentorTurnInput;
    try {
      if (turnNumber === 1) {
        questionInput = await openingLessonMentorQuestion({
          persona,
          moduleName,
          lessonName,
          lessonContent,
        });
      } else {
        const decision = await followUpLessonMentor({
          persona,
          moduleName,
          lessonName,
          priorTurns: recordedQuestions,
          priorReplies: recordedReplies,
          turnNumber,
        });
        if (decision.decision === 'stop' || !decision.question) {
          endedReason = `persona stopped after turn ${turnNumber - 1}: ${decision.reasoning}`;
          break;
        }
        questionInput = { question: decision.question, reasoning: decision.reasoning };
      }
    } catch (e) {
      endedReason = `persona-LLM failed at turn ${turnNumber}: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }

    logDetail(
      `  lesson-mentor T${turnNumber}: "${questionInput.question.slice(0, 80)}${questionInput.question.length > 80 ? '…' : ''}"`,
    );
    const turnStart = Date.now();
    try {
      const response = await client.chatWithLessonMentor({
        courseId,
        moduleIndex,
        lessonIndex,
        message: questionInput.question,
      });
      turns.push({
        turnNumber,
        question: questionInput.question,
        questionRationale: questionInput.reasoning,
        response,
        durationMs: Date.now() - turnStart,
      });
      recordedQuestions.push(questionInput);
      recordedReplies.push(response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      turns.push({
        turnNumber,
        question: questionInput.question,
        questionRationale: questionInput.reasoning,
        response: '',
        durationMs: Date.now() - turnStart,
        error: msg,
      });
      endedReason = `mentor error at turn ${turnNumber}: ${msg}`;
      break;
    }
  }

  return {
    scope: 'lesson',
    moduleIndex,
    lessonIndex,
    moduleName,
    lessonName,
    turns,
    endedReason,
    totalDurationMs: Date.now() - overallStart,
  };
}

// ── Main Pipeline ────────────────────────────────────────

export async function runPersonaFlow({
  persona,
  client,
  recorder,
  config,
  label,
  runId,
  personaSlug,
}: {
  persona: Persona;
  client: ApiClient;
  recorder: MarkdownRecorder;
  config: OrchestratorConfig;
  label: string;
  runId: string;
  personaSlug: string;
}): Promise<PersonaRun> {
  const log = (msg: string) => console.log(`[${label}]`.cyan + ` ${msg}`);
  const logDone = (msg: string) => console.log(`[${label}]`.cyan + ` ${msg}`.green);
  const logDetail = (msg: string) => console.log(`[${label}]`.cyan + ` ${msg}`.gray);
  const flowStart = Date.now();
  const steps: StepResult[] = [];
  let courseId = '';
  let course: CourseData | null = null;
  // Tracks the step currently in-flight (cleared on its successful finish) so
  // the failure branch knows *where* things died even when `steps[]` only
  // contains completed steps.
  let currentStep: { step: number; name: string } | null = null;

  const beginStep = ({ step, name }: { step: number; name: string }) => {
    currentStep = { step, name };
    const inner = timedStep({ step, name });
    return {
      finish(notes?: string): StepResult {
        const r = inner.finish(notes);
        currentStep = null;
        return r;
      },
    };
  };

  recorder.setPersona(persona);
  recorder.addHeader();

  try {
    // ── Step 1: Create Course ────────────────────────────
    log('Step 1: Creating course...');
    const s1 = beginStep({ step: 1, name: 'Create Course' });
    courseId = await client.createCourse(persona.goal);
    const r1 = s1.finish();
    steps.push(r1);
    recorder.setCourseId(courseId);
    recorder.addStep1_CreateCourse({ result: r1, courseId });
    logDone(`Step 1 done → courseId: ${courseId}`);

    // ── Step 2: Clarify (Question Generation) ───────────
    log('Step 2: Generating clarify questions...');
    const s2 = beginStep({ step: 2, name: 'Clarify Questions' });
    const pollStart2 = Date.now();
    const clarifyJobId = await client.submitJob({ courseId, path: 'clarify' });
    await client.pollJob({ jobId: clarifyJobId });
    const pollDuration2 = Date.now() - pollStart2;
    course = await client.getCourse(courseId);
    let questions = (course.clarifyData?.questions ?? []) as ClarifyQuestion[];

    // Guard: the clarify-generation schema refinement requires ≥1 text
    // question, but belt-and-suspenders: the orchestrator fails loudly if
    // a regression (prompt change, schema weakening, LLM skipping the
    // rule after retries exhausted) ever ships 0 text questions. Matches
    // the assessment rubric's C9 criterion (free-text clarify present
    // and used). Fail-fast keeps downstream persona-grounding correctness
    // observable in the debug run output rather than silently degrading.
    const textQuestionCount = questions.filter((q) => q.type === 'text').length;
    if (textQuestionCount < 1) {
      throw new Error(
        `Clarify guard: 0 text questions generated (schema refinement bypassed or LLM exhausted retries). Question types: ${questions.map((q) => q.type).join(', ')}`,
      );
    }

    // Capture the pre-flight classifier's output. The clarify job (api
    // services/courseService.ts:classifyGoalType) writes course.goalType,
    // course.goalTypeConfidence, and course.clarifyData.goalTypeNoun
    // before the question-generation Haiku runs — surface all three so
    // the assessor can score classification accuracy + confidence
    // calibration + chip-label quality against persona.predictedGoalType.
    const classification: GoalTypeClassificationSnapshot = {
      goalType: course.goalType ?? null,
      confidence: course.goalTypeConfidence ?? null,
      noun: course.clarifyData?.goalTypeNoun ?? null,
    };
    if (!classification.goalType || !classification.confidence) {
      // Hard fail — the clarify job is contractually required to emit a
      // classification (the classifier falls back to master/low on any
      // error). Missing fields here imply the api change wasn't deployed
      // or the schema lookup is silently dropping the value. Fail loudly
      // so a deploy gap is visible in the run output, not in the
      // assessment write-up.
      throw new Error(
        `Clarify guard: classifier output missing on course doc — goalType=${course.goalType ?? 'null'}, confidence=${course.goalTypeConfidence ?? 'null'}. Verify the clarify-job persistence path in jobRunner.ts.`,
      );
    }
    const matchesPredicted = classification.goalType === persona.predictedGoalType;

    const r2 = s2.finish(
      `${questions.length} questions (${textQuestionCount} text); ` +
        `classifier: ${classification.goalType}/${classification.confidence} ` +
        `(predicted: ${persona.predictedGoalType}, ${matchesPredicted ? 'match' : 'MISMATCH'})`,
    );
    steps.push(r2);
    recorder.addStep2_Clarify({
      result: r2,
      questions,
      pollDuration: pollDuration2,
      classification,
      predictedGoalType: persona.predictedGoalType,
      predictedGoalTypeReasoning: persona.predictedGoalTypeReasoning,
    });
    logDone(
      `Step 2 done → ${questions.length} questions (${textQuestionCount} text); ` +
        `goalType=${classification.goalType}/${classification.confidence}` +
        (matchesPredicted ? ` (${'match'.green})` : ` (${'MISMATCH'.yellow}, predicted ${persona.predictedGoalType})`),
    );

    // ── Step 2b: Goal-Type Override ─────────────────────
    //
    // Always runs when the persona has a non-null override target.
    // Exercises the chip-toggle cascade end-to-end:
    //   1. PATCH /course with the new goalType (api server marks
    //      goalTypeConfidence='high').
    //   2. Re-submit a clarify job (regenerates questions tilted to the
    //      new goalType, classifier is skipped because confidence='high').
    //   3. Re-fetch course; replace `questions` so Step 3 onward operates
    //      on the post-override question set.
    // The before/after snapshot is recorded for the assessor to diff —
    // if the questions don't actually change shape, the tilt is broken.
    let goalTypeOverride: GoalTypeOverrideRecord | null = null;
    if (persona.goalTypeOverrideTarget) {
      const target = persona.goalTypeOverrideTarget;
      log(`Step 2b: Toggling goalType chip → ${target}...`);
      const s2b = beginStep({ step: 2, name: `Goal-Type Override → ${target}` });
      const overrideStart = Date.now();
      const before: GoalTypeClassificationSnapshot = { ...classification };
      const clarifyQuestionsBefore = questions;

      // Step 1 of the override cascade — PATCH sets goalTypeConfidence='high'
      // on the course doc; the next clarify job will skip the classifier.
      await client.updateCourse({ courseId, updates: { goalType: target } });

      // Step 2 — submit a fresh clarify job. Same job submission path as
      // the initial Step 2 above; jobRunner reads course.goalTypeConfidence
      // to decide whether to re-classify (it won't — confidence is high)
      // and runs the question generator with the user-picked goalType.
      const overrideJobId = await client.submitJob({ courseId, path: 'clarify' });
      await client.pollJob({ jobId: overrideJobId });
      course = await client.getCourse(courseId);
      questions = (course.clarifyData?.questions ?? []) as ClarifyQuestion[];

      const after: GoalTypeClassificationSnapshot = {
        goalType: course.goalType ?? null,
        confidence: course.goalTypeConfidence ?? null,
        noun: course.clarifyData?.goalTypeNoun ?? null,
      };
      goalTypeOverride = {
        before,
        target,
        after,
        clarifyQuestionsBefore,
        clarifyQuestionsAfter: questions,
        durationMs: Date.now() - overrideStart,
      };

      // Cascade integrity guard — surface a server-side regression
      // (PATCH didn't persist, clarify regen didn't honor the high
      // confidence) immediately rather than letting it ride into the
      // structure prompt. The assessor still gets the snapshot so the
      // failure is visible in the report.
      if (after.goalType !== target) {
        throw new Error(
          `Goal-type override cascade failed: after.goalType=${after.goalType ?? 'null'}, expected ${target}. Verify updateCourse controller cascade rules.`,
        );
      }
      if (after.confidence !== 'high') {
        throw new Error(
          `Goal-type override cascade failed: after.confidence=${after.confidence ?? 'null'}, expected 'high'. Verify updateCourse controller cascade rules.`,
        );
      }

      const r2b = s2b.finish(
        `${before.goalType}→${after.goalType} (${after.confidence}); regenerated ${questions.length} questions`,
      );
      steps.push(r2b);
      recorder.addStep2b_GoalTypeOverride(goalTypeOverride);
      logDone(
        `Step 2b done → switched ${before.goalType}→${after.goalType}, regenerated ${questions.length} questions in ${(goalTypeOverride.durationMs / 1000).toFixed(1)}s`,
      );
    }

    // ── Step 3: Answer Questions (AI as Persona) ────────
    log('Step 3: Answering questions as persona...');
    const s3 = beginStep({ step: 3, name: 'Answer Questions' });
    const { answers, reasoning: answerReasoning } = await answerQuestionsAsPersona({ persona, questions });
    await client.updateCourse({ courseId, updates: { answers } });
    const r3 = s3.finish(answerReasoning);
    steps.push(r3);
    recorder.addStep3_Answers({ result: r3, answers, questions, aiReasoning: answerReasoning });
    logDone('Step 3 done → answers submitted');

    // ── Step 4: Depth Previews ──────────────────────────
    log('Step 4: Generating depth previews...');
    const s4 = beginStep({ step: 4, name: 'Depth Previews' });
    const pollStart4 = Date.now();
    const depthJobId = await client.submitJob({ courseId, path: 'depth-previews' });
    await client.pollJob({ jobId: depthJobId });
    const pollDuration4 = Date.now() - pollStart4;
    course = await client.getCourse(courseId);
    const depthPreviews = course.depthPreviews!;
    const r4 = s4.finish(`recommended: ${depthPreviews.recommended}`);
    steps.push(r4);
    recorder.addStep4_DepthPreviews({ result: r4, previews: depthPreviews, pollDuration: pollDuration4 });
    logDone(`Step 4 done → recommended: ${depthPreviews.recommended}`);

    // ── Step 5: Select Depth (AI as Persona) ────────────
    log('Step 5: Selecting depth as persona...');
    const s5 = beginStep({ step: 5, name: 'Select Depth' });
    const { depth, reasoning: depthReasoning } = await selectDepthAsPersona({ persona, depthPreviews });
    // First attempt: post the depth without acknowledgement. The backend's
    // bidirectional gate may return 409 with one of two codes:
    //   - DEPTH_OVERRIDE_REQUIRES_ACK     — overcommit (picked too big)
    //   - DEPTH_UNDERCOMMIT_REQUIRES_ACK  — undercommit (picked too small)
    // Either way, retry once with depthOverrideAcknowledged: true (the same
    // flag works for both — only one side fires per PATCH). The full 409
    // payload is dumped to the terminal so an investigator sees the dialog
    // copy + ranges + risk + rationale right next to the persona's pick.
    // For the silent-pass case, tail the API server's stdout for the line
    // `course:depth-gate outcome=...` to see the full predicate breakdown.
    try {
      await client.updateCourse({ courseId, updates: { depth } });
      if (depth !== depthPreviews.recommended) {
        logDetail(
          `Step 5: depth-gate did NOT fire (selected=${depth}, recommended=${depthPreviews.recommended}). ` +
            `See API server log "course:depth-gate outcome=..." for the predicate breakdown.`,
        );
      }
    } catch (e) {
      const err = e as { status?: number; data?: Record<string, unknown> & { code?: string } };
      const code = err?.status === 409 ? err.data?.code : undefined;
      if (code === 'DEPTH_OVERRIDE_REQUIRES_ACK' || code === 'DEPTH_UNDERCOMMIT_REQUIRES_ACK') {
        const direction = code === 'DEPTH_OVERRIDE_REQUIRES_ACK' ? 'OVERCOMMIT' : 'UNDERCOMMIT';
        const { code: _c, message: _m, ...diag } = err.data!;
        logDetail(
          `Step 5: depth-gate FIRED (${direction}) — ${err.data!.message ?? '(no message)'}\n` +
            `         payload: ${JSON.stringify(diag)}`,
        );
        await client.updateCourse({ courseId, updates: { depth, depthOverrideAcknowledged: true } });
      } else {
        throw e;
      }
    }
    const r5 = s5.finish(depthReasoning);
    steps.push(r5);
    recorder.addStep5_DepthSelection({
      result: r5,
      selected: depth,
      recommended: depthPreviews.recommended,
      aiReasoning: depthReasoning,
    });
    logDone(
      `Step 5 done → selected: ${depth}` +
        (depth !== depthPreviews.recommended
          ? ` (recommended: ${depthPreviews.recommended})`.yellow
          : ` (recommended: ${depthPreviews.recommended})`),
    );

    // ── Step 6: Generate Structure ──────────────────────
    log('Step 6: Generating course structure...');
    const s6 = beginStep({ step: 6, name: 'Generate Structure' });
    const pollStart6 = Date.now();
    const structJobId = await client.submitJob({ courseId, path: 'generate-structure' });
    // Structure generation runs `withRetry` once for the base attempt and
    // then, under Phase 4's cap validation, may run a full second
    // generation to trim an over-cap result. Worst case ≈ 2×120s per call
    // within each retry cycle. 300s default is tight; 10 min gives headroom.
    await client.pollJob({ jobId: structJobId, timeoutMs: WITH_RETRY_POLL_TIMEOUT_MS });
    const pollDuration6 = Date.now() - pollStart6;
    course = await client.getCourse(courseId);
    const structure = course.structure!;
    const totalLessons = structure.modules.reduce((sum, m) => sum + m.lessons.length, 0);
    const r6 = s6.finish(`${structure.modules.length} modules, ${totalLessons} lessons`);
    steps.push(r6);
    recorder.addStep6_Structure({ result: r6, structure, pollDuration: pollDuration6 });
    logDone(`Step 6 done → ${structure.modules.length} modules, ${totalLessons} lessons`);

    // ── Step 7: Review Structure (AI as Persona) ────────
    log('Step 7: Reviewing structure...');
    const s7 = beginStep({ step: 7, name: 'Review Structure' });
    let feedback: string | null = null;
    let chatResponse: string | null = null;
    let structureChanged = false;

    if (config.enableChatReview) {
      const review = await reviewStructureAsPersona({ persona, structure });

      if (!review.satisfied && review.feedback) {
        feedback = review.feedback;
        logDetail(`Step 7: Sending feedback: "${feedback}"`);

        const structureBefore = JSON.stringify(course.structure?.modules);
        chatResponse = await client.postSSE({
          path: `/api/course/${courseId}/chat`,
          body: { messages: [{ role: 'user', content: feedback }] },
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
    recorder.addStep7_Review({ result: r7, feedback, aiResponse: chatResponse, structureChanged });
    logDone(
      `Step 7 done → ${feedback ? `feedback sent, structure ${structureChanged ? 'changed'.green : 'unchanged'.yellow}` : 'accepted as-is'}`,
    );

    // ── Step 8: Accept Course ───────────────────────────
    log('Step 8: Accepting course...');
    const s8 = beginStep({ step: 8, name: 'Accept Course' });
    await client.updateCourse({ courseId, updates: { status: 'ready' } });
    course = await client.getCourse(courseId);
    const r8 = s8.finish();
    steps.push(r8);
    recorder.addStep8_Accept(r8);
    logDone('Step 8 done → course accepted');

    // ── Step 8b: Course Mentor Probe ────────────────────
    //
    // Multi-turn conversation (up to MAX_MENTOR_TURNS) against the
    // course-design chat. This isn't a structure-refinement attempt
    // (Step 7 owns that path); it's a "would the chat help me orient
    // before I dive in?" probe. Each turn is captured for the assessor.
    let courseMentor: CourseMentorRecord | null = null;
    if (config.enableMentor) {
      log('Step 8b: Probing course mentor (multi-turn)...');
      const s8b = beginStep({ step: 8, name: 'Course Mentor Probe' });
      courseMentor = await runCourseMentorConversation({
        persona,
        course,
        client,
        courseId,
        logDetail,
      });
      const totalChars = courseMentor.turns.reduce((sum, t) => sum + t.response.length, 0);
      steps.push(s8b.finish(`${courseMentor.turns.length} turns, ${totalChars} chars`));
      recorder.addStep8b_CourseMentorProbe(courseMentor);
      logDone(`Step 8b done → ${courseMentor.turns.length} turns, ${courseMentor.endedReason}`);
    }

    // ── Steps 9+10: Generate & Complete Lessons ─────────
    let lessonsGenerated = 0;
    const lessonContents: {
      moduleIndex: number;
      lessonIndex: number;
      moduleName: string;
      lessonName: string;
      content: ILessonContent;
      generationMs: number;
      stats: LessonContentStats | null;
      mentorProbe: LessonMentorRecord | null;
    }[] = [];

    if (config.maxLessons > 0) {
      // Refetch the course to pick up any structure mutations that
      // happened after the last refetch in Step 8. The course-mentor
      // probe (Step 8b) shares the design-chat endpoint with Step 7,
      // so the agent has access to `modify_structure` and CAN mutate
      // the course mid-conversation when the persona signs off on a
      // tweak ("yes, add that setup lesson before module 1"). Iterating
      // from stale `course.structure` would underrun the server's
      // assertPreviousLessonGenerated guard several lessons later — a
      // 400 surfaces as `Generate the previous lesson first (module
      // N, lesson M)` and aborts the persona run after some lessons
      // were already generated. Cheap (single GET) and a no-op when
      // no upstream mutation happened.
      course = await client.getCourse(courseId);
    }

    if (config.maxLessons > 0 && course.structure?.modules) {
      const modules = course.structure.modules;
      log(`Steps 9-10: Generating up to ${config.maxLessons} lessons...`);

      for (let mi = 0; mi < modules.length && lessonsGenerated < config.maxLessons; mi++) {
        const mod = modules[mi];
        for (let li = 0; li < mod.lessons.length && lessonsGenerated < config.maxLessons; li++) {
          const lesson = mod.lessons[li];
          const lessonLabel = `[${mi}/${li}] ${mod.name} → ${lesson.name}`;

          // ── Step 9: Generate & Log ──────────────
          logDetail(`Generating lesson ${lessonLabel}...`);
          const s9 = beginStep({ step: 9, name: `Generate Lesson ${mi}/${li}` });
          const genStart = Date.now();

          // Hero images cost real money (BFL API) and are irrelevant to the
          // assessment signal, so opt out for the whole orchestrator run.
          // Links are kept on — they're one of the quality signals we grade.
          const jobId = await client.generateLesson({
            courseId,
            moduleIndex: mi,
            lessonIndex: li,
            includeImage: false,
            includeLinks: true,
          });
          await client.pollJob({ jobId, timeoutMs: LESSON_POLL_TIMEOUT_MS });
          const content = await client.getLessonContent({ courseId, moduleIndex: mi, lessonIndex: li });

          // Pull insight/link counts from the debug-only stats endpoint so the
          // report can surface generation-quality signals (how many insights
          // were extracted, how many links survived curation) that the
          // lesson-content response itself doesn't expose. Non-fatal if it
          // fails (e.g. endpoint not mounted in a non-development env).
          let stats: LessonContentStats | null = null;
          try {
            stats = await client.getLessonContentStats({ courseId, moduleIndex: mi, lessonIndex: li });
          } catch (err) {
            logDetail(`  (stats endpoint unavailable: ${err instanceof Error ? err.message : String(err)})`);
          }

          const generationMs = Date.now() - genStart;
          const r9 = s9.finish(`${content.blocks.length} blocks, ${(generationMs / 1000).toFixed(1)}s`);
          steps.push(r9);

          // ── Step 9b: Lesson Mentor Probe ────────
          //
          // Multi-turn conversation (up to MAX_MENTOR_TURNS) against the
          // lesson mentor, posed *after* reading but *before* marking
          // the lesson complete. The mentor gets the lesson content via
          // the system prompt in the controller; persona's questions
          // reference what they actually read.
          let mentorProbe: LessonMentorRecord | null = null;
          if (config.enableMentor) {
            const sLM = beginStep({ step: 9, name: `Lesson Mentor ${mi}/${li}` });
            mentorProbe = await runLessonMentorConversation({
              persona,
              moduleIndex: mi,
              lessonIndex: li,
              moduleName: mod.name,
              lessonName: lesson.name,
              lessonContent: content,
              client,
              courseId,
              logDetail,
            });
            const totalChars = mentorProbe.turns.reduce((sum, t) => sum + t.response.length, 0);
            steps.push(sLM.finish(`${mentorProbe.turns.length} turns, ${totalChars} chars`));
          }

          lessonContents.push({
            moduleIndex: mi,
            lessonIndex: li,
            moduleName: mod.name,
            lessonName: lesson.name,
            content,
            generationMs,
            stats,
            mentorProbe,
          });

          logDone(
            `Generated lesson ${lessonLabel} (${content.blocks.length} blocks, ${(generationMs / 1000).toFixed(1)}s)`,
          );

          // ── Step 10: Complete Lesson ────────────
          const s10 = beginStep({ step: 10, name: `Complete Lesson ${mi}/${li}` });
          await client.completeLessonProgress({ courseId, moduleIndex: mi, lessonIndex: li });
          const r10 = s10.finish();
          steps.push(r10);

          lessonsGenerated++;
        }
      }

      recorder.addStep9_LessonGeneration(lessonContents);
      logDone(`Lesson generation complete: ${lessonsGenerated}/${config.maxLessons} lessons`);
    }

    // ── Step 11: Generate Module Quizzes ────────────────
    //
    // Only modules where every lesson was generated in this run are eligible.
    // The production controller gates on LessonContentModel counts and returns
    // 400 LESSONS_NOT_GENERATED otherwise, so matching the gate here keeps the
    // script noise-free.
    const quizRecords: ModuleQuizAttemptRecord[] = [];
    if (config.enableQuiz && course.structure?.modules && lessonContents.length > 0) {
      const lessonsByModule = new Map<number, Set<number>>();
      for (const lc of lessonContents) {
        if (!lessonsByModule.has(lc.moduleIndex)) lessonsByModule.set(lc.moduleIndex, new Set());
        lessonsByModule.get(lc.moduleIndex)!.add(lc.lessonIndex);
      }

      const modules = course.structure.modules;
      const eligibleModuleIndices: number[] = [];
      for (let mi = 0; mi < modules.length; mi++) {
        const generated = lessonsByModule.get(mi);
        if (!generated) continue;
        if (generated.size === modules[mi].lessons.length) eligibleModuleIndices.push(mi);
      }

      if (eligibleModuleIndices.length > 0) {
        log(`Step 11: Generating quizzes for ${eligibleModuleIndices.length} module(s)...`);

        const generatedQuizzes: {
          moduleIndex: number;
          moduleName: string;
          quiz: ModuleQuizForLearner;
          generationMs: number;
        }[] = [];

        for (const mi of eligibleModuleIndices) {
          const moduleName = modules[mi].name;
          const s11 = beginStep({ step: 11, name: `Generate Module Quiz ${mi}` });
          const genStart = Date.now();

          const jobId = await client.generateModuleQuiz({ courseId, moduleIndex: mi });
          // Quiz generation wraps a Sonnet call in withRetry (3 retries,
          // 120s per-attempt timeout); worst case ≈ 8 min. 300s default
          // causes the orchestrator to time out before the server's
          // retry chain can finish — the real failure never surfaces in
          // the report. 10 min lets the job complete cleanly.
          await client.pollJob({ jobId, timeoutMs: WITH_RETRY_POLL_TIMEOUT_MS });
          const quiz = await client.getModuleQuiz({ courseId, moduleIndex: mi });
          const generationMs = Date.now() - genStart;

          steps.push(s11.finish(`${quiz.questions.length} questions, ${(generationMs / 1000).toFixed(1)}s`));
          generatedQuizzes.push({ moduleIndex: mi, moduleName, quiz, generationMs });
          logDone(
            `Step 11: Generated quiz for [${mi}] ${moduleName} (${quiz.questions.length} q, ${(generationMs / 1000).toFixed(1)}s)`,
          );
        }

        recorder.addStep11_ModuleQuizGeneration({ quizzes: generatedQuizzes });

        // ── Step 12: Submit Quiz Attempts ──────────────
        log(`Step 12: Submitting quiz attempts for ${generatedQuizzes.length} module(s)...`);
        for (const gq of generatedQuizzes) {
          const s12 = beginStep({ step: 12, name: `Submit Quiz ${gq.moduleIndex}` });
          const subStart = Date.now();

          const { responses, reasoning, simulatedSubmissionMs, llmLatencyMs, noiseTrace } = await answerQuizAsPersona({
            persona,
            moduleName: gq.moduleName,
            questions: gq.quiz.questions,
            runId,
            personaSlug,
          });
          const result = await client.submitModuleQuiz({
            courseId,
            moduleIndex: gq.moduleIndex,
            responses,
          });
          // NB: `submissionMs` in the record is the SIMULATED persona think-
          // time, not the wall-clock latency. The real LLM latency is stored
          // alongside as `llmLatencyMs`. This fixes the F28 "quiz gaming
          // detector" case where 4.1-4.4s wall-clock was being reported as
          // the persona's submission time, invalidating the rubric signal.
          const _actualWallClockMs = Date.now() - subStart; // retained as local for potential future debugging; not persisted

          quizRecords.push({
            moduleIndex: gq.moduleIndex,
            moduleName: gq.moduleName,
            score: result.score,
            masteryTier: result.masteryTier,
            attemptNumber: result.attemptNumber,
            reviewIntervalDays: result.reviewIntervalDays,
            nextReviewAt: result.nextReviewAt,
            generationMs: gq.generationMs,
            submissionMs: simulatedSubmissionMs,
            llmLatencyMs,
            questions: result.questions,
            aiReasoning: reasoning,
            noiseTrace,
          });

          steps.push(s12.finish(`score ${result.score} → ${result.masteryTier}`));
          logDone(`Step 12: [${gq.moduleIndex}] ${gq.moduleName} → ${result.score}/100 (${result.masteryTier})`);
        }

        recorder.addStep12_QuizAttempts({ attempts: quizRecords });
      } else {
        logDetail('Step 11-12: No module has all its lessons generated, skipping quiz phase');
      }
    } else if (config.enableQuiz) {
      logDetail('Step 11-12: Quizzes enabled but no lessons were generated, skipping');
    }

    // ── Step 13: Fetch Insight Queue ────────────────────
    // ── Step 14: Review Insights ───────────────────────
    const insightReviews: InsightReviewResult[] = [];
    let statsAfter: InsightStats | null = null;
    if (config.enableInsights) {
      log('Step 13: Fetching insight queue...');
      const s13 = beginStep({ step: 13, name: 'Fetch Insight Queue' });
      const queue: GetInsightQueueResult = await client.getInsightQueue();
      steps.push(
        s13.finish(
          `due ${queue.counts.dueTotal}, fresh ${queue.counts.freshAvailable}, learned ${queue.counts.learned}`,
        ),
      );
      recorder.addStep13_InsightQueue({ queue });
      logDone(
        `Step 13: queue → due ${queue.counts.dueTotal}, fresh ${queue.counts.freshAvailable}, learned ${queue.counts.learned}`,
      );

      // Due-first, then fresh. Review everything the server returned — the
      // queue is already bounded server-side (`INSIGHT_QUEUE_DUE_LIMIT` +
      // `INSIGHT_QUEUE_FRESH_LIMIT_DEFAULT`), so no extra client-side cap.
      const candidates: QueueInsightItem[] = [...queue.due, ...queue.fresh];

      if (candidates.length > 0) {
        log(`Step 14: Reviewing ${candidates.length} insight(s)...`);
        let skippedSoFar = false;

        for (const item of candidates) {
          const s14 = beginStep({ step: 14, name: `Review Insight ${item.insightId.slice(-6)}` });

          if (shouldSkipInsight({ persona, item, alreadySkipped: skippedSoFar })) {
            await client.skipInsight({ insightId: item.insightId });
            skippedSoFar = true;
            insightReviews.push({
              insightId: item.insightId,
              courseName: item.courseName,
              lessonName: item.lessonName,
              kind: item.kind,
              prompt: item.prompt,
              canonicalAnswer: item.answer,
              mode: item.mode,
              action: 'skipped',
              aiReasoning: 'Style indicates skipping a hard fresh card',
            });
            steps.push(s14.finish('skipped'));
            logDetail(
              `  [skip] ${item.kind} — ${item.prompt.length > 60 ? item.prompt.slice(0, 60) + '...' : item.prompt}`,
            );
            continue;
          }

          const targetMode = pickModeFromPersona({ persona, currentMode: item.mode });
          if (targetMode !== item.mode) {
            await client.setInsightMode({ insightId: item.insightId, mode: targetMode });
          }

          if (targetMode === 'tap-reveal') {
            const { rating, reasoning } = await reviewInsightTapReveal({ persona, insight: item, runId, personaSlug });
            const rated = await client.rateInsight({ insightId: item.insightId, rating });
            insightReviews.push({
              insightId: item.insightId,
              courseName: item.courseName,
              lessonName: item.lessonName,
              kind: item.kind,
              prompt: item.prompt,
              canonicalAnswer: item.answer,
              mode: 'tap-reveal',
              action: 'rated',
              rating,
              newBox: rated.box,
              nextDue: rated.nextDue ? new Date(rated.nextDue).toISOString() : null,
              aiReasoning: reasoning,
            });
            steps.push(s14.finish(`tap-reveal → ${rating}`));
            logDetail(`  [tap] ${item.kind} → ${rating} (box ${rated.box})`);
          } else {
            const { userAnswer, reasoning } = await reviewInsightTypedRecall({
              persona,
              insight: item,
              runId,
              personaSlug,
            });
            const grade = await client.gradeInsight({ insightId: item.insightId, userAnswer });
            const rating = mapGradeToRating(grade.score);
            const rated = await client.rateInsight({
              insightId: item.insightId,
              rating,
              typedMatch: grade.score,
            });
            insightReviews.push({
              insightId: item.insightId,
              courseName: item.courseName,
              lessonName: item.lessonName,
              kind: item.kind,
              prompt: item.prompt,
              canonicalAnswer: item.answer,
              mode: 'typed-recall',
              userAnswer,
              grade,
              action: 'rated',
              rating,
              newBox: rated.box,
              nextDue: rated.nextDue ? new Date(rated.nextDue).toISOString() : null,
              aiReasoning: reasoning,
            });
            steps.push(s14.finish(`typed ${grade.verdict} → ${rating}`));
            logDetail(`  [typed] ${item.kind} → ${grade.verdict} (${grade.score.toFixed(2)}) → ${rating}`);
          }
        }

        try {
          statsAfter = await client.getInsightStats();
        } catch {
          // stats are informational — don't fail the run if the endpoint hiccups
        }

        recorder.addStep14_InsightReviews({ reviews: insightReviews, statsAfter });
        logDone(
          `Step 14: reviewed ${insightReviews.filter((r) => r.action === 'rated').length}, skipped ${insightReviews.filter((r) => r.action === 'skipped').length}`,
        );
      } else {
        logDetail('Step 14: Queue empty, nothing to review');
      }
    }

    // ── Write report ────────────────────────────────────
    const totalDurationMs = Date.now() - flowStart;
    recorder.addSummary({
      totalDurationMs,
      course,
      status: 'completed',
      lessonsGenerated: lessonsGenerated > 0 ? lessonsGenerated : undefined,
      quizzesAttempted: quizRecords.length > 0 ? quizRecords.length : undefined,
      insightsReviewed: insightReviews.length > 0 ? insightReviews.length : undefined,
    });
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
    const errorMsg = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const shortMsg = error instanceof Error ? error.message : String(error);
    // TS narrows `currentStep` to `never` in this catch because it can't see
    // the closure mutation inside `beginStep` — cast back to the declared type.
    const failedStep = currentStep as { step: number; name: string } | null;
    const stepLabel = failedStep ? `step ${failedStep.step} (${failedStep.name})` : 'unknown step';
    console.log(`[${label}]`.cyan + ` FAILED at ${stepLabel}: ${shortMsg}`.red);

    try {
      if (!course && courseId) {
        try {
          course = await client.getCourse(courseId);
        } catch {
          // can't fetch course, use what we have
        }
      }
      // Always record the failure body + summary so the report is useful even
      // when we blew up before a course existed (e.g. step-1 insert collision).
      recorder.addFailure({ failedStep, error: errorMsg });
      recorder.addSummary({
        totalDurationMs,
        course,
        status: 'failed',
        error: shortMsg,
        failedStep: failedStep ?? undefined,
      });
      const filepath = await recorder.writeToFile(config.outputDir);
      logDetail(`Failure report written → ${filepath}`);
    } catch (writeErr) {
      // Surface write-side failures instead of swallowing them — if the
      // recorder itself is broken, silent drop is how "missing logs" regressions
      // sneak in.
      const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      console.log(`[${label}]`.cyan + ` Failed to write failure report: ${writeMsg}`.red);
    }

    return {
      persona,
      courseId,
      steps,
      totalDurationMs,
      status: 'failed',
      error: shortMsg,
    };
  }
}
