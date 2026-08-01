import type { ICourse } from '@models/CourseModel';
import type { CourseDepth, GoalType, GoalTypeConfidence, QuestionType, SourceFidelity } from '@lib/constants';
import type { RecallCardKind, RecallMode, RecallRating } from '@lib/recallConstants';
import type { ClientSourceDocument } from '@services/sourceDocumentService';
import type { SizeBand, PerDocumentAnalysis } from '@services/documentAssessment';

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
 * Structured recall-review flags parsed from the free-text
 * `recallReviewStyle`. Drives typed-recall answer degradation and
 * tap-reveal rating bias.
 */
export interface RecallStyleFlags {
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
    recallReviewStyle: string;
  };
  /**
   * Structured flags derived from the free-text behavior fields at
   * persona-generation time. Kept alongside the descriptions so the
   * markdown report still shows the human-readable explanation, but the
   * runtime noise-injection paths read from here (structured) instead of
   * re-parsing prose.
   */
  quizStyleFlags: QuizStyleFlags;
  recallStyleFlags: RecallStyleFlags;
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
  /**
   * Documents-mode extension (only set when the orchestrator runs with
   * --documents). Describes how this persona relates to the document set
   * they were generated to own: why they plausibly have these files, how
   * tightly they'd want generation to follow them, and whether they'd
   * accept or edit the AI-suggested goal on the analysis screen. Absent
   * on goal-mode personas — the generator's output shape is unchanged
   * there.
   */
  documentsProfile?: DocumentsPersonaProfile | null;
}

/**
 * Docs-mode persona dimensions (see Persona.documentsProfile). Typed
 * separately so the docs-mode persona schema and the courseFlow D4
 * decision step share one contract.
 */
export interface DocumentsPersonaProfile {
  /**
   * 1-2 sentences: why THIS persona owns THIS document set (e.g.
   * "collected these lecture notes over a semester of Bio 101"). Must be
   * consistent with the set's filenames + previews.
   */
  ownershipStory: string;
  /** Fidelity the persona is predicted to pick on the analysis screen. */
  predictedFidelity: SourceFidelity;
  /** One sentence: why that fidelity fits this persona's intent. */
  predictedFidelityReasoning: string;
  /** Whether they'd accept the AI-suggested goal verbatim or edit it. */
  suggestedGoalStance: 'accept' | 'edit';
  /** How they'd edit it (or why they'd accept it as-is). */
  suggestedGoalStanceReasoning: string;
}

export interface OrchestratorConfig {
  apiUrl: string;
  concurrency: number;
  outputDir: string;
  enableChatReview: boolean;
  enableQuiz: boolean;
  enableRecall: boolean;
  /**
   * When true, persona asks one open-ended question against the
   * course-design chat after accepting the structure (Step 8b) AND one
   * question against the lesson mentor for each generated lesson
   * (Step 9b). Off by default — adds ~3-5 s + a Haiku call per lesson.
   */
  enableMentor: boolean;
  /**
   * Per-feature lesson generation toggles, mirroring the client-side
   * options on the lesson-gen UI. Off-by-default for `recall` so cohort
   * runs include spaced-retrieval extraction (the typical user path);
   * the inverse `--no-*` flags let the operator strip features to
   * isolate cost contribution per node (e.g. "lessons with no recall vs
   * with recall, compare credit totals").
   */
  includeHero: boolean;
  includeLinks: boolean;
  includeRecall: boolean;
  maxLessons: number;
  /**
   * Optional cohort bias. When set, the persona generator is constrained
   * to emit personas matching this distribution (`{ pass: 3, build: 2 }`
   * → 3 pass-bucket personas + 2 build-bucket personas). Sum must equal
   * `personaCount`. Used to stress-test a single bucket's curriculum
   * shape without re-rolling cohorts hoping for coverage. `null` =
   * unbiased (the default — generator uses its own ≥5 coverage rule).
   */
  goalTypeDistribution: Partial<Record<GoalType, number>> | null;
  /**
   * Documents mode (--documents): personas build their course from an
   * uploaded document set instead of a typed goal. The pipeline swaps
   * Step 1 for create-shell → upload → ingest → analysis review →
   * goal+fidelity PATCH, then rejoins the standard clarify → … flow.
   */
  documentsMode: boolean;
  /**
   * Per-persona document-set names, length === personaCount (a
   * --document-set run repeats the one name). Null in goal mode.
   * Resolved by resolveDocumentSetSelection in documentSets.ts.
   */
  documentSetNames: string[] | null;
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
  /**
   * Per-bucket curriculum-quality assertions, populated as the run
   * progresses. The orchestrator's cohort aggregator reads these
   * directly so per-bucket × per-metric drift is visible across runs.
   * Either field is `undefined` if the run failed before that step
   * completed.
   *
   * Note: importing the actual types from `./goalTypeAssertions` here
   * would create a circular boundary (assertions → types). They're
   * shaped under `PersonaAssertions` below as a structural mirror so
   * `types.ts` stays the foundational module.
   */
  assertions?: PersonaAssertions;
  /**
   * Per-step latency capture so the cohort aggregator can compute
   * p50/avg generation time per goalType bucket — surfaces a
   * regression that only slows one bucket's pipeline.
   */
  metrics?: PersonaMetrics;
  /**
   * Per-step credit-spend snapshots. Populated even on partial runs (each
   * snapshot is recorded immediately after its step completes, so a
   * failure mid-run still leaves a partial cost trail). Surfaced in the
   * markdown report's `## Cost Breakdown` section and aggregated into the
   * orchestrator's cohort total.
   */
  costSummary?: CostSummary;
}

export interface PersonaAssertions {
  cue?: { goalType: GoalType; verdict: 'pass' | 'fail' | 'n-a' };
  structure?: { goalType: GoalType; verdict: 'pass' | 'fail' | 'n-a' };
}

export interface PersonaMetrics {
  /** Step 6 poll duration — structure generation latency. */
  structureGenMs?: number;
  /** Sum of per-lesson generation duration (ms) across the run. */
  lessonGenMsTotal?: number;
  lessonsGenerated?: number;
  quizzesAttempted?: number;
  /** Average quiz score [0..1] across attempted module quizzes. */
  quizScoreAvg?: number;
}

// ── Cost tracking (analytics, not evaluation) ───────────
//
// Captured per-persona via /api/billing/summary snapshots at every step
// boundary. NOT scored by the assessment rubric — surfaced in markdown
// reports for cost analytics and in the cohort summary at run completion.

/** One per-step cost snapshot. `deltaCredits = balanceBefore - balanceAfter`. */
export interface CostEvent {
  /** Step label (e.g. "Step 6: Generate Structure", "Step 9: Lesson [0/2]"). */
  label: string;
  /** Credit balance before this step ran. */
  balanceBefore: number;
  /** Credit balance after this step ran. */
  balanceAfter: number;
  /** Credits debited during this step. Negative would indicate a refill (rare). */
  deltaCredits: number;
  /** Wall-clock when the post-step snapshot was taken. */
  ts: Date;
}

export interface CostSummary {
  /** Credit balance at the start of the persona run (before Step 1). */
  startBalance: number;
  /** Credit balance at the end of the persona run (after the last step). */
  endBalance: number;
  /** Sum of all event deltas — total credits spent during this persona run. */
  totalSpent: number;
  /** Per-step events in chronological order. */
  events: CostEvent[];
  /**
   * Per-feature credit cost rolled up by UsageEvent.action label. Populated
   * at end-of-run by querying UsageEventModel directly (the orchestrator
   * already has a Mongo connection). Lets reports answer "of this persona's
   * 268 credits, how much went to lesson:recall vs lesson:image vs
   * lesson:content?" — orthogonal to the per-step balance-delta view above.
   */
  byAction?: { action: string; credits: number; count: number }[];
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
  | 'source'
  | 'sourceFidelity'
  | 'sourceAssessment'
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
  recallCardCount: number;
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

// ── Documents mode (orchestrator-only) ───────────────────
//
// Records for the docs-mode pipeline steps (D1–D8). Server shapes are
// imported from the real modules (`ClientSourceDocument` mirrors GET
// /documents rows; `SizeBand`/`PerDocumentAnalysis` mirror the persisted
// `course.sourceAssessment`) so a server-side contract change surfaces
// as a compile error here, not a silently-wrong report.

/**
 * The coarse SourceAnalysis persisted on `course.sourceAssessment` by the
 * ingest job — the exact `toSourceAnalysis` projection from
 * api/src/services/documentAssessment.ts (the model stores it as Mixed,
 * so the orchestrator re-types it structurally on read).
 */
export interface SourceAnalysisView {
  topics: string[];
  sizeBand: SizeBand;
  teachableDensity: number;
  suggestedGoal: string;
  questions: string[];
  warnings: string[];
  perDocument: PerDocumentAnalysis[];
}

/** One upload attempt (file or manifest URL) during docs-mode Step 1b. */
export interface DocumentUploadRecord {
  kind: 'file' | 'url';
  /** Filename for files; the URL string for url-kind rows. */
  name: string;
  byteSize?: number;
  outcome: 'accepted' | 'rejected';
  /** Server error (status + body) when the upload was rejected. */
  error?: string;
  /** Server row on success — status/warnings surface in the report. */
  document?: ClientSourceDocument;
  durationMs: number;
}

/** Docs-mode Step 1d — the persona's analysis-screen decision. */
export interface GoalFidelityRecord {
  suggestedGoal: string;
  acceptedSuggestedGoal: boolean;
  finalGoal: string;
  fidelity: SourceFidelity;
  aiReasoning: string;
  /** The generator's predicted stance, for prediction-vs-actual scoring. */
  predictedStance: 'accept' | 'edit';
  stanceMatchedPrediction: boolean;
  predictedFidelity: SourceFidelity;
  fidelityMatchedPrediction: boolean;
  durationMs: number;
}

/** Docs-mode Step 5b — whether/why prepare_corpus fired. */
export interface CorpusPreparationRecord {
  needed: boolean;
  /** Per-document predicate breakdown (name + reason string). */
  perDocument: { name: string; needsPreparation: boolean; reason: string }[];
  /** Job wall-clock (submit → poll complete). Only set when `needed`. */
  jobMs?: number;
}

/** Docs-mode band-adherence check recorded after Step 6. */
export interface BandAdherenceRecord {
  depth: CourseDepth;
  /** The picked tier's displayed lesson-count range (from depthPreviews). */
  tierRange: [number, number] | null;
  sourceTierNote: string | null;
  sizeBand: SizeBand | null;
  totalLessons: number;
  /**
   * in-band     — within the displayed tier range.
   * tolerated   — exactly min−1 (the server's accepted band per FEEDBACK-1C).
   * out-of-band — outside both.
   * n-a         — no tier range was displayed (preview lacked the field).
   */
  verdict: 'in-band' | 'tolerated' | 'out-of-band' | 'n-a';
  groundedLessons: number;
  supplementedLessons: number;
  perLesson: { moduleIndex: number; lessonIndex: number; name: string; sourceRefsCount: number }[];
}

// ── Recall review (orchestrator-only) ───────────────────

export interface RecallReviewResult {
  recallCardId: string;
  courseName: string;
  lessonName: string;
  kind: RecallCardKind;
  prompt: string;
  canonicalAnswer: string;
  mode: RecallMode;
  /** typed-recall only */
  userAnswer?: string;
  /** typed-recall only */
  grade?: { score: number; verdict: 'correct' | 'partial' | 'incorrect'; feedback: string };
  action: 'rated' | 'skipped';
  /** only set when action === 'rated' */
  rating?: RecallRating;
  newBox?: number;
  nextDue?: string | null;
  aiReasoning: string;
}
