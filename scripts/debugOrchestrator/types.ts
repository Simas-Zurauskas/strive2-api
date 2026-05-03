import type { ICourse } from '@models/CourseModel';
import type { CourseDepth, GoalType, GoalTypeConfidence, QuestionType } from '@lib/constants';
import type { InsightKind, InsightMode, InsightRating } from '@lib/insightConstants';

// ── Persona (orchestrator-only) ──────────────────────────

/**
 * Structured quiz-taking behavior flags parsed from the free-text
 * `quizAttemptStyle`. Drives the answer-noise injection in
 * `answerQuizAsPersona` via the seeded PRNG — see quizNoise.ts.
 *
 * Precedence when multiple fire simultaneously: `rushes` > `guessesWhenUnsure`
 * > `secondGuesses` > `eliminates`. The `eliminates` flag is effectively the
 * "careful reader" baseline; the others model specific failure modes.
 */
export interface QuizStyleFlags {
  /** Picks first plausible option; no re-reading. Position-biased on long stems. */
  rushes: boolean;
  /** Changes a correct answer at the last moment ("overthinks the last question"). */
  secondGuesses: boolean;
  /** Eliminates obviously-wrong distractors before picking. Generally the "careful" trait. */
  eliminates: boolean;
  /** Random pick when confidence is low. Distinct from `rushes` — this is deliberate guessing. */
  guessesWhenUnsure: boolean;
}

/**
 * Structured insight-review flags parsed from the free-text
 * `insightReviewStyle`. Drives typed-recall answer degradation and
 * tap-reveal rating bias.
 */
export interface InsightStyleFlags {
  /** Types short, imperfect answers; would grade "partial" on exact-match canon. */
  struggles: boolean;
  /** Types canonical-quality answers. The stable persona baseline. */
  articulate: boolean;
  /** Skews tap-reveal ratings high regardless of actual recall. */
  generous: boolean;
  /** Skews tap-reveal ratings low regardless of actual recall. */
  harsh: boolean;
}

export interface Persona {
  name: string;
  background: string;
  goal: string;
  personality: string;
  priorities: string;
  wizardBehavior: {
    surveyStyle: string;
    depthChoice: string;
    structureReview: string;
    quizAttemptStyle: string;
    insightReviewStyle: string;
  };
  /**
   * Structured flags derived from the free-text behavior fields at
   * persona-generation time. Kept alongside the descriptions so the
   * markdown report still shows the human-readable explanation, but the
   * runtime noise-injection paths read from here (structured) instead of
   * re-parsing prose.
   */
  quizStyleFlags: QuizStyleFlags;
  insightStyleFlags: InsightStyleFlags;
  /**
   * Ground-truth goalType for this persona's goal — what the pre-flight
   * classifier *should* emit if it works correctly. Set by the persona
   * generator based on the goal text + stated intent. The orchestrator
   * records the actual classifier output alongside, so the assessor can
   * score classification accuracy. Independent of `domain`; orthogonal axis.
   */
  predictedGoalType: GoalType;
  /**
   * One-sentence rationale for why the persona's goal maps to that
   * goalType. Surfaces ground truth in the report so a misclassification
   * has something to argue against.
   */
  predictedGoalTypeReasoning: string;
  /**
   * Optional override-test target. When set AND the orchestrator was
   * launched with --goal-type-override, the orchestrator runs an extra
   * "chip-toggle" cycle after Step 2: PATCH /course with this goalType,
   * re-submits clarify, and proceeds with the new questions. Tests the
   * cascade end-to-end. Personas where this is set should be ones who
   * would realistically change their mind (Skeptic, Anxious Learner).
   * Null on personas who would accept the classification as-is.
   */
  goalTypeOverrideTarget: GoalType | null;
}

export interface OrchestratorConfig {
  apiUrl: string;
  concurrency: number;
  outputDir: string;
  enableChatReview: boolean;
  enableQuiz: boolean;
  enableInsights: boolean;
  /**
   * When true, persona asks one open-ended question against the
   * course-design chat after accepting the structure (Step 8b) AND one
   * question against the lesson mentor for each generated lesson
   * (Step 9b). Off by default — adds ~3-5 s + a Haiku call per lesson.
   */
  enableMentor: boolean;
  maxLessons: number;
}

export interface StepResult {
  step: number;
  name: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  request?: { method: string; url: string; body?: unknown };
  response?: unknown;
  notes?: string;
}

export interface PersonaRun {
  persona: Persona;
  courseId: string;
  steps: StepResult[];
  totalDurationMs: number;
  status: 'completed' | 'failed';
  error?: string;
}

// ── Re-exported from real models ─────────────────────────

/**
 * A single clarify question. Mirrors ICourse.clarifyData.questions[n]
 * but narrows `type` from string → QuestionType (the model uses string,
 * the Zod schema validates it as QuestionType at runtime).
 */
export type ClarifyQuestion = Omit<NonNullable<ICourse['clarifyData']>['questions'][number], 'type'> & {
  type: QuestionType;
};

/** Depth preview for a single tier, derived from ICourse.depthPreviews */
export type DepthPreview = NonNullable<ICourse['depthPreviews']>['overview'];

/** All three depth previews + recommendation */
export type DepthPreviews = NonNullable<ICourse['depthPreviews']>;

/** Course structure with reasoning + modules */
export type CourseStructure = NonNullable<ICourse['structure']>;

/** The API response shape for GET /api/course/:id (subset of ICourse relevant to the orchestrator) */
export type CourseData = Pick<
  ICourse,
  | 'name'
  | 'goal'
  | 'status'
  | 'domain'
  | 'goalType'
  | 'goalTypeConfidence'
  | 'clarifyData'
  | 'answers'
  | 'depth'
  | 'depthPreviews'
  | 'structure'
  | 'feedbackHistory'
> & { _id: string };

// Re-export for convenience
export type { CourseDepth, GoalType, GoalTypeConfidence };
export type { ILessonContent, ILessonBlock } from '@models/LessonContentModel';

// ── Goal-type classification & override (orchestrator-only) ───
//
// Captured per-run so the assessment rubric can score:
//  - classification accuracy (predicted vs classified),
//  - confidence calibration (high on clear cases, low on garbage),
//  - clarify-question tilt to the classified goalType,
//  - override cascade integrity (when --goal-type-override fires).

/** Snapshot of the classifier's output as persisted on the course doc. */
export interface GoalTypeClassificationSnapshot {
  goalType: GoalType | null;
  confidence: GoalTypeConfidence | null;
  noun: string | null;
}

export interface GoalTypeOverrideRecord {
  /** What the classifier emitted before the override (Step 2 baseline). */
  before: GoalTypeClassificationSnapshot;
  /** Target goalType the persona switched to via the chip. */
  target: GoalType;
  /** Server state after PATCH + clarify regen completed. */
  after: GoalTypeClassificationSnapshot;
  /** Question set the classifier-driven clarify produced (for diff). */
  clarifyQuestionsBefore: ClarifyQuestion[];
  /** Question set after the override-driven clarify regen. */
  clarifyQuestionsAfter: ClarifyQuestion[];
  /** Wall-clock for the whole override cycle (PATCH → poll). */
  durationMs: number;
}

/** Response shape from the dev-only /lesson-content/:m/:l/stats endpoint. */
export interface LessonContentStats {
  blockCount: number;
  blockCountsByType: Record<string, number>;
  insightCount: number;
  linkCount: number;
}

// ── Module quiz (endpoint response shapes) ───────────────
//
// The server has no exported type for these responses — the controllers
// build anonymous shapes before res.json. Mirror the shapes the orchestrator
// consumes and keep the fields narrowed to what we actually use.

/** Stripped question shape from GET /api/course/:id/module-quiz/:m. */
export interface ModuleQuizQuestionForLearner {
  id: string;
  question: string;
  options: string[];
  sourceLessons: number[];
  isInterleaved: boolean;
  interleavedModuleIndex: number | null;
}

export interface ModuleQuizForLearner {
  courseId: string;
  moduleIndex: number;
  questions: ModuleQuizQuestionForLearner[];
  version: number;
}

/** Per-question shape returned after submit — includes correctIndex + explanation. */
export interface GradedQuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  sourceLessons: number[];
  isInterleaved: boolean;
  interleavedModuleIndex: number | null;
  selectedOption: number | null;
  correct: boolean;
}

export interface QuizAttemptResult {
  attemptNumber: number;
  score: number;
  masteryTier: 'needs_review' | 'passed' | 'mastered';
  completedAt: string;
  questions: GradedQuizQuestion[];
  nextReviewAt: string;
  reviewIntervalDays: number;
}

/**
 * Per-question trace of answer-noise injection, written to the markdown
 * report so assessment reruns can verify the simulator is firing
 * realistically. `finalOption` is what was submitted to the server;
 * `originalOption` is what the LLM picked before noise.
 */
export interface QuizNoiseTrace {
  questionId: string;
  originalOption: number;
  finalOption: number;
  confidence: number;
  injections: string[];
}

/** Per-module record saved by the orchestrator for the markdown report. */
export interface ModuleQuizAttemptRecord {
  moduleIndex: number;
  moduleName: string;
  score: number;
  masteryTier: QuizAttemptResult['masteryTier'];
  attemptNumber: number;
  reviewIntervalDays: number;
  nextReviewAt: string;
  generationMs: number;
  /**
   * Simulated persona think-time in ms (derived from stem length + style
   * flags). This is the number surfaced in the markdown report because it
   * represents "how long a persona like this would spend". The raw LLM
   * latency is separately recorded as `llmLatencyMs` for debugging.
   */
  submissionMs: number;
  llmLatencyMs: number;
  questions: GradedQuizQuestion[];
  aiReasoning: string;
  /** One entry per quiz question, in order. Empty when noise injection is disabled. */
  noiseTrace: QuizNoiseTrace[];
}

// ── Mentor-chat probes (orchestrator-only) ───────────────
//
// Multi-turn record. Each probe is a real conversation (up to 3 turns,
// persona stops early when satisfied). The server keeps chat history
// itself (LessonMentorChat / CourseDesignChat), so per turn we send
// only the new user message and the server stitches prior context.
// The assessor reads `turns` as the raw signal for domain
// "I. Mentor experience" in the rubric.

export interface MentorTurn {
  /** 1-indexed; matches the order in which turns were exchanged. */
  turnNumber: number;
  /** What the persona typed. */
  question: string;
  /** AI-as-persona reasoning for why this question fits the persona right now. */
  questionRationale: string;
  /** Full assistant text concatenated from SSE deltas. */
  response: string;
  /** Wall-clock time for this single turn (request start → last SSE chunk). */
  durationMs: number;
  /** Mentor-side error if the SSE stream surfaced one (credit gate, agent crash, etc.). */
  error?: string;
}

export interface MentorChatProbeRecord {
  /** All turns recorded in order. Empty when the very first probe call failed. */
  turns: MentorTurn[];
  /**
   * AI-as-persona narration for why the conversation ended where it did
   * — "satisfied after turn 2", "ran out of useful follow-ups", "hit
   * 3-turn cap". Surfaces the persona's signal-to-noise ratio for the
   * assessor.
   */
  endedReason: string;
  /** Sum of every turn's durationMs. */
  totalDurationMs: number;
}

export interface CourseMentorRecord extends MentorChatProbeRecord {
  /** Path: course-design chat, scoped to the whole course (no lesson coords). */
  scope: 'course';
}

export interface LessonMentorRecord extends MentorChatProbeRecord {
  scope: 'lesson';
  moduleIndex: number;
  lessonIndex: number;
  moduleName: string;
  lessonName: string;
}

// ── Insight review (orchestrator-only) ───────────────────

export interface InsightReviewResult {
  insightId: string;
  courseName: string;
  lessonName: string;
  kind: InsightKind;
  prompt: string;
  canonicalAnswer: string;
  mode: InsightMode;
  /** typed-recall only */
  userAnswer?: string;
  /** typed-recall only */
  grade?: { score: number; verdict: 'correct' | 'partial' | 'incorrect'; feedback: string };
  action: 'rated' | 'skipped';
  /** only set when action === 'rated' */
  rating?: InsightRating;
  newBox?: number;
  nextDue?: string | null;
  aiReasoning: string;
}
