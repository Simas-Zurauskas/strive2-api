import type { ICourse } from '@models/CourseModel';
import type { CourseDepth, QuestionType } from '@lib/constants';
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
}

export interface OrchestratorConfig {
  apiUrl: string;
  concurrency: number;
  outputDir: string;
  enableChatReview: boolean;
  enableQuiz: boolean;
  enableInsights: boolean;
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
  'name' | 'goal' | 'status' | 'domain' | 'clarifyData' | 'answers' | 'depth' | 'depthPreviews' | 'structure' | 'feedbackHistory'
> & { _id: string };

// Re-export for convenience
export type { CourseDepth };
export type { ILessonContent, ILessonBlock } from '@models/LessonContentModel';

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
