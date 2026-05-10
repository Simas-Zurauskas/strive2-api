import { OpenAPIV3 } from 'openapi-types';
import { ERROR_CODES } from '@middleware/errorMiddleware';
import { AUTH_PROVIDERS, COURSE_DEPTHS, COURSE_DOMAINS, COURSE_STATUSES, GOAL_TYPES, GOAL_TYPE_CONFIDENCES, JOB_TYPES, JOB_STATUSES, LESSON_PROGRESS_STATUSES, QUESTION_TYPES, QUIZ_MASTERY_TIERS } from '@lib/constants';
import { ACHIEVEMENT_CATEGORIES, XP_SOURCES } from '@lib/gamificationConstants';
import { BLOCK_TYPES } from '@models/LessonContentModel';
import { RECALL_CARD_KINDS, RECALL_MODES, RECALL_RATINGS, RECALL_STATES } from '@lib/recallConstants';
import { USAGE_SERVICES } from '@lib/usageConstants';
import { CREDIT_LEDGER_REASONS } from '@models/CreditLedgerModel';
import { SECURITY_ACTIONS } from '@models/SecurityActionTokenModel';

type SchemaMap = Record<string, OpenAPIV3.SchemaObject>;

// Helper for nullable $ref — OpenAPI 3.0 requires allOf wrapper
const nullableRef = (ref: string): OpenAPIV3.SchemaObject => ({
  nullable: true,
  allOf: [{ $ref: ref }] as unknown as OpenAPIV3.SchemaObject[],
} as unknown as OpenAPIV3.SchemaObject);

export const schemas: SchemaMap = {
  // ── Enum schemas ─────────────────────────────────────────

  ErrorCode: {
    type: 'string',
    enum: [...ERROR_CODES],
  },

  AuthProviderType: {
    type: 'string',
    enum: [...AUTH_PROVIDERS],
  },

  QuestionType: {
    type: 'string',
    enum: [...QUESTION_TYPES],
  },

  CourseDepth: {
    type: 'string',
    enum: [...COURSE_DEPTHS],
  },

  CourseStatus: {
    type: 'string',
    enum: [...COURSE_STATUSES],
  },

  CourseDomain: {
    type: 'string',
    enum: [...COURSE_DOMAINS],
  },

  GoalType: {
    type: 'string',
    enum: [...GOAL_TYPES],
  },

  GoalTypeConfidence: {
    type: 'string',
    enum: [...GOAL_TYPE_CONFIDENCES],
  },

  JobStatusEnum: {
    type: 'string',
    enum: [...JOB_STATUSES],
  },

  JobType: {
    type: 'string',
    enum: [...JOB_TYPES],
  },

  LessonProgressStatus: {
    type: 'string',
    enum: [...LESSON_PROGRESS_STATUSES],
  },

  QuizMasteryTier: {
    type: 'string',
    enum: [...QUIZ_MASTERY_TIERS],
  },

  BlockType: {
    type: 'string',
    enum: [...BLOCK_TYPES],
  },

  ReviewReason: {
    type: 'string',
    enum: ['time', 'progression'],
  },

  UsageService: {
    type: 'string',
    enum: [...USAGE_SERVICES],
  },

  // ── Object schemas ───────────────────────────────────────

  ApiError: {
    type: 'object',
    required: ['message'],
    properties: {
      message: { type: 'string' },
      errorCode: { $ref: '#/components/schemas/ErrorCode' },
      // Optional structured error metadata. For 402 INSUFFICIENT_CREDITS the
      // shape is `{ need: number, have: number }`. Kept as a free-form object
      // so new error codes can add fields without a schema churn every time.
      meta: {
        type: 'object',
        additionalProperties: true,
      },
      requestId: { type: 'string' },
    },
  },

  AuthProvider: {
    type: 'object',
    required: ['provider'],
    properties: {
      provider: { $ref: '#/components/schemas/AuthProviderType' },
      providerId: { type: 'string' },
    },
  },

  PlanKey: {
    type: 'string',
    enum: ['free', 'starter', 'pro', 'studio'],
  },

  SubscriptionStatus: {
    type: 'string',
    enum: ['active', 'past_due', 'canceling', 'canceled'],
  },

  BillingCadence: {
    type: 'string',
    enum: ['monthly', 'annual'],
  },

  CreditLedgerReason: {
    type: 'string',
    enum: [...CREDIT_LEDGER_REASONS],
  },

  UserSubscription: {
    type: 'object',
    required: ['plan', 'status', 'cancelAtPeriodEnd'],
    properties: {
      plan: { $ref: '#/components/schemas/PlanKey' },
      status: { $ref: '#/components/schemas/SubscriptionStatus' },
      cancelAtPeriodEnd: { type: 'boolean' },
      pendingPlan: { $ref: '#/components/schemas/PlanKey' },
      currentPeriodStart: { type: 'string', format: 'date-time' },
      currentPeriodEnd: { type: 'string', format: 'date-time' },
    },
  },

  UserCredits: {
    type: 'object',
    required: ['allowanceBalance', 'allowanceGranted', 'bonusBalance', 'periodStart', 'periodEnd'],
    properties: {
      allowanceBalance: { type: 'integer', minimum: 0 },
      allowanceGranted: { type: 'integer', minimum: 0 },
      bonusBalance: { type: 'integer', minimum: 0 },
      periodStart: { type: 'string', format: 'date-time' },
      periodEnd: { type: 'string', format: 'date-time' },
    },
  },

  AuthorisedUser: {
    type: 'object',
    required: [
      '_id',
      'email',
      'emailVerified',
      'isAdmin',
      'authProviders',
      'subscription',
      'credits',
      'preferences',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      _id: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      image: { type: 'string' },
      emailVerified: { type: 'boolean' },
      isAdmin: { type: 'boolean' },
      authProviders: {
        type: 'array',
        items: { $ref: '#/components/schemas/AuthProvider' },
      },
      subscription: { $ref: '#/components/schemas/UserSubscription' },
      credits: { $ref: '#/components/schemas/UserCredits' },
      preferences: { $ref: '#/components/schemas/UserPreferences' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  BillingPlan: {
    type: 'object',
    required: [
      'key',
      'displayName',
      'description',
      'monthlyUsd',
      'annualMonthlyUsd',
      'annualUsd',
      'monthlyAllowance',
      'maxConcurrentJobs',
    ],
    properties: {
      key: { $ref: '#/components/schemas/PlanKey' },
      displayName: { type: 'string' },
      // One-paragraph public-facing blurb. Mirrors the matching Stripe
      // product description so /pricing and Checkout copy stay aligned.
      description: { type: 'string' },
      monthlyUsd: { type: 'number' },
      annualMonthlyUsd: { type: 'number' },
      annualUsd: { type: 'number' },
      monthlyAllowance: { type: 'integer' },
      maxConcurrentJobs: { type: 'integer' },
    },
  },

  BillingTopupRate: {
    type: 'object',
    required: ['creditsPerUsd', 'minUsd', 'maxUsd'],
    properties: {
      // How many credits one USD buys. Integer so any whole-dollar amount
      // yields an integer credit grant.
      creditsPerUsd: { type: 'integer' },
      // Inclusive bounds enforced both client-side (input clamping) and
      // server-side (Zod schema on the /topup endpoint).
      minUsd: { type: 'integer' },
      maxUsd: { type: 'integer' },
    },
  },

  BillingCatalog: {
    type: 'object',
    required: ['plans', 'topupRate'],
    properties: {
      plans: {
        type: 'array',
        items: { $ref: '#/components/schemas/BillingPlan' },
      },
      topupRate: { $ref: '#/components/schemas/BillingTopupRate' },
    },
  },

  BillingSummary: {
    type: 'object',
    required: ['plan', 'displayName', 'status', 'cancelAtPeriodEnd', 'credits'],
    properties: {
      plan: { $ref: '#/components/schemas/PlanKey' },
      displayName: { type: 'string' },
      status: { $ref: '#/components/schemas/SubscriptionStatus' },
      cancelAtPeriodEnd: { type: 'boolean' },
      pendingPlan: {
        // nullable-via-oneOf would be stricter but openapi-types v12 rejects
        // `{ type: 'null' }`. Using a nullable $ref wrapper instead.
        allOf: [{ $ref: '#/components/schemas/PlanKey' }],
        nullable: true,
      },
      credits: {
        type: 'object',
        required: ['allowance', 'bonus', 'total', 'allowanceGranted', 'periodStart', 'periodEnd'],
        properties: {
          allowance: { type: 'integer' },
          bonus: { type: 'integer' },
          total: { type: 'integer' },
          allowanceGranted: { type: 'integer' },
          periodStart: { type: 'string', format: 'date-time' },
          periodEnd: { type: 'string', format: 'date-time' },
        },
      },
    },
  },

  CreditLedgerEntry: {
    type: 'object',
    required: [
      '_id',
      'userId',
      'timestamp',
      'delta',
      'allowanceDelta',
      'bonusDelta',
      'balanceBefore',
      'balanceAfter',
      'bonusBefore',
      'bonusAfter',
      'reason',
    ],
    properties: {
      _id: { type: 'string' },
      userId: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
      delta: { type: 'integer' },
      allowanceDelta: { type: 'integer' },
      bonusDelta: { type: 'integer' },
      balanceBefore: { type: 'integer' },
      balanceAfter: { type: 'integer' },
      bonusBefore: { type: 'integer' },
      bonusAfter: { type: 'integer' },
      reason: { $ref: '#/components/schemas/CreditLedgerReason' },
      actionType: { type: 'string' },
      jobId: { type: 'string' },
      notes: { type: 'string' },
    },
  },

  ClarifyQuestion: {
    type: 'object',
    required: ['id', 'question', 'type'],
    properties: {
      id: { type: 'string' },
      question: { type: 'string' },
      type: { $ref: '#/components/schemas/QuestionType' },
      options: { type: 'array', items: { type: 'string' } },
    },
  },

  ClarifyResponse: {
    type: 'object',
    required: ['courseName', 'questions'],
    properties: {
      courseName: { type: 'string' },
      questions: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClarifyQuestion' },
      },
      goalTypeNoun: {
        type: 'string',
        description: "Chip label noun phrase produced by the goalType classifier (e.g. 'your YouTube channel', 'the CPA exam'). The verb (e.g. 'monetize', 'pass') is a static client-side map keyed off course.goalType.",
      },
    },
  },

  CourseAnswer: {
    type: 'object',
    required: ['questionId', 'answer'],
    properties: {
      questionId: { type: 'string' },
      answer: { type: 'string' },
    },
  },

  CourseLesson: {
    type: 'object',
    required: ['name', 'description'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
    },
  },

  CourseModule: {
    type: 'object',
    required: ['name', 'description', 'lessons'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      lessons: {
        type: 'array',
        items: { $ref: '#/components/schemas/CourseLesson' },
      },
    },
  },

  StructureReasoning: {
    type: 'object',
    required: ['learnerProfile', 'topicAnalysis', 'scopeDecisions', 'progressionStrategy'],
    properties: {
      learnerProfile: { type: 'string' },
      topicAnalysis: { type: 'string' },
      scopeDecisions: { type: 'string' },
      progressionStrategy: { type: 'string' },
    },
  },

  GenerateStructureResponse: {
    type: 'object',
    required: ['courseName', 'reasoning', 'modules'],
    properties: {
      courseName: { type: 'string' },
      reasoning: { $ref: '#/components/schemas/StructureReasoning' },
      modules: {
        type: 'array',
        items: { $ref: '#/components/schemas/CourseModule' },
      },
    },
  },

  DepthPreview: {
    type: 'object',
    required: ['summary', 'bullets'],
    properties: {
      summary: { type: 'string' },
      bullets: { type: 'array', items: { type: 'string' } },
      lessonCountRange: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description:
          'Optional. [min, max] estimated total lesson count for this tier, derived from the (depth, isSoft) lesson-count hints. Computed server-side at depth-previews generation time, or backfilled at read time on legacy courses. Absent on courses persisted before this field was added.',
      },
      estimatedHoursRange: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description:
          'Optional. [min, max] estimated total learner-facing hours for this tier. Derived from lessonCountRange × ~25 minutes per lesson, rounded up, with a floor of 1 hour. Absent on legacy courses.',
      },
    },
  },

  DepthPreviewsResponse: {
    type: 'object',
    required: ['overview', 'comprehensive', 'deep_dive', 'recommended', 'recommendationReason'],
    properties: {
      overview: { $ref: '#/components/schemas/DepthPreview' },
      comprehensive: { $ref: '#/components/schemas/DepthPreview' },
      deep_dive: { $ref: '#/components/schemas/DepthPreview' },
      recommended: { $ref: '#/components/schemas/CourseDepth' },
      recommendationReason: { type: 'string' },
      overcommitRisk: {
        type: 'string',
        enum: ['low', 'moderate', 'high'],
        description:
          'Optional. LLM-emitted holistic judgment of how likely the learner is to over-commit if they pick a depth above `recommended`. Drives the depth-override gate as the primary cost signal — `high` triggers a confirmation dialog when combined with an expansion signal; `moderate` triggers when combined with a large-course expansion (>15 lessons). Absent on courses persisted before this field was added; the gate falls back to phrase-regex softness/finish-pressure detection in that case.',
      },
      overcommitRationale: {
        type: 'string',
        description:
          'Optional. One-sentence rationale for `overcommitRisk`, referencing specific answer content (e.g. "Mentioned \'just want to learn the basics\'"). Surfaced verbatim in the 409 confirmation dialog and gate-fire logs. Absent when `overcommitRisk` is absent.',
      },
      undercommitRisk: {
        type: 'string',
        enum: ['low', 'moderate', 'high'],
        description:
          'Optional. LLM-emitted judgment of how poorly served the learner will be if they pick a depth BELOW `recommended` — the symmetric coverage-gap signal to `overcommitRisk`. `moderate` or `high` triggers the undercommit half of the depth-override gate (separate 409 code DEPTH_UNDERCOMMIT_REQUIRES_ACK) so the learner is warned before committing to a tier that would skip practical applications they explicitly asked about. Absent on legacy courses; absence means no undercommit warning will fire (we have no regex fallback for deadline/professional-goal phrasing).',
      },
      undercommitRationale: {
        type: 'string',
        description:
          'Optional. One-sentence rationale for `undercommitRisk`, referencing specific answer content (e.g. "You said the interview is in 3 weeks"). Surfaced verbatim in the 409 dialog and gate-fire logs. Absent when `undercommitRisk` is absent.',
      },
    },
  },

  JobStatus: {
    type: 'object',
    required: ['status', 'type', 'courseId'],
    properties: {
      status: { $ref: '#/components/schemas/JobStatusEnum' },
      type: { $ref: '#/components/schemas/JobType' },
      courseId: { type: 'string' },
      error: { type: 'string' },
      metadata: { type: 'object', nullable: true, additionalProperties: true },
    },
  },

  LessonBlock: {
    type: 'object',
    required: ['id', 'type', 'content', 'metadata', 'order'],
    properties: {
      id: { type: 'string' },
      type: { $ref: '#/components/schemas/BlockType' },
      content: { type: 'string' },
      metadata: { type: 'object', nullable: true, additionalProperties: true },
      order: { type: 'integer' },
    },
  },

  LessonContent: {
    type: 'object',
    required: ['_id', 'courseId', 'moduleIndex', 'lessonIndex', 'blocks', 'version'],
    properties: {
      _id: { type: 'string' },
      courseId: { type: 'string' },
      moduleIndex: { type: 'integer' },
      lessonIndex: { type: 'integer' },
      blocks: {
        type: 'array',
        items: { $ref: '#/components/schemas/LessonBlock' },
      },
      heroImageUrl: { type: 'string', nullable: true },
      includeHeroImage: { type: 'boolean' },
      audioUrl: { type: 'string', nullable: true },
      audioVoice: { type: 'string', nullable: true },
      audioRate: { type: 'number', nullable: true },
      audioContentHash: { type: 'string', nullable: true },
      audioGeneratedAt: { type: 'string', format: 'date-time', nullable: true },
      summary: { type: 'string', nullable: true },
      version: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  NarrationVoice: {
    type: 'object',
    required: ['id', 'label', 'locale', 'gender', 'description'],
    properties: {
      id: { type: 'string' },
      label: { type: 'string' },
      locale: { type: 'string' },
      gender: { type: 'string', enum: ['male', 'female', 'neutral'] },
      description: { type: 'string' },
    },
  },

  NarrationVoicesResponse: {
    type: 'object',
    required: ['defaultVoiceId', 'voices'],
    properties: {
      defaultVoiceId: { type: 'string' },
      voices: { type: 'array', items: { $ref: '#/components/schemas/NarrationVoice' } },
    },
  },

  UserPreferences: {
    type: 'object',
    required: ['narrationVoice', 'narrationRate'],
    properties: {
      narrationVoice: { type: 'string', description: 'Empty string means "no preference" — server falls back to the catalog default.' },
      narrationRate: { type: 'number', minimum: 0.5, maximum: 2.0 },
    },
  },

  QuizResponse: {
    type: 'object',
    required: ['blockId', 'selectedOption', 'correct'],
    properties: {
      blockId: { type: 'string' },
      selectedOption: { type: 'integer' },
      correct: { type: 'boolean' },
      answeredAt: { type: 'string', format: 'date-time' },
    },
  },

  ExerciseAttempt: {
    type: 'object',
    required: ['blockId', 'code', 'passed'],
    properties: {
      blockId: { type: 'string' },
      code: { type: 'string' },
      passed: { type: 'boolean' },
      attemptedAt: { type: 'string', format: 'date-time' },
    },
  },

  UserLessonProgress: {
    type: 'object',
    required: ['_id', 'userId', 'courseId', 'moduleIndex', 'lessonIndex', 'status', 'lastAccessedAt', 'timeSpentSeconds', 'quizResponses', 'exerciseAttempts', 'bookmarked'],
    properties: {
      _id: { type: 'string' },
      userId: { type: 'string' },
      courseId: { type: 'string' },
      moduleIndex: { type: 'integer' },
      lessonIndex: { type: 'integer' },
      status: { $ref: '#/components/schemas/LessonProgressStatus' },
      completedAt: { type: 'string', format: 'date-time', nullable: true },
      lastAccessedAt: { type: 'string', format: 'date-time' },
      timeSpentSeconds: { type: 'integer' },
      quizResponses: {
        type: 'array',
        items: { $ref: '#/components/schemas/QuizResponse' },
      },
      exerciseAttempts: {
        type: 'array',
        items: { $ref: '#/components/schemas/ExerciseAttempt' },
      },
      notes: { type: 'string', nullable: true },
      bookmarked: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  CourseProgressStats: {
    type: 'object',
    required: ['total', 'completed', 'percentage'],
    properties: {
      total: { type: 'integer' },
      completed: { type: 'integer' },
      inProgress: { type: 'integer' },
      percentage: { type: 'integer' },
    },
  },

  ModuleQuizQuestion: {
    type: 'object',
    required: ['id', 'question', 'options', 'sourceLessons', 'isInterleaved'],
    properties: {
      id: { type: 'string' },
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      sourceLessons: { type: 'array', items: { type: 'integer' } },
      isInterleaved: { type: 'boolean' },
      interleavedModuleIndex: { type: 'integer' },
    },
  },

  ModuleQuizContent: {
    type: 'object',
    required: ['courseId', 'moduleIndex', 'questions', 'version'],
    properties: {
      courseId: { type: 'string' },
      moduleIndex: { type: 'integer' },
      questions: {
        type: 'array',
        items: { $ref: '#/components/schemas/ModuleQuizQuestion' },
      },
      version: { type: 'integer' },
    },
  },

  QuizAttemptQuestionResult: {
    type: 'object',
    required: ['id', 'question', 'options', 'correctIndex', 'explanation', 'sourceLessons', 'isInterleaved', 'selectedOption', 'correct'],
    properties: {
      id: { type: 'string' },
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      correctIndex: { type: 'integer' },
      explanation: { type: 'string' },
      sourceLessons: { type: 'array', items: { type: 'integer' } },
      isInterleaved: { type: 'boolean' },
      interleavedModuleIndex: { type: 'integer' },
      selectedOption: { type: 'integer', nullable: true },
      correct: { type: 'boolean' },
    },
  },

  QuizAttemptResult: {
    type: 'object',
    required: ['attemptNumber', 'score', 'masteryTier', 'completedAt', 'questions', 'nextReviewAt', 'reviewIntervalDays'],
    properties: {
      attemptNumber: { type: 'integer' },
      score: { type: 'number' },
      masteryTier: { $ref: '#/components/schemas/QuizMasteryTier' },
      completedAt: { type: 'string', format: 'date-time' },
      questions: {
        type: 'array',
        items: { $ref: '#/components/schemas/QuizAttemptQuestionResult' },
      },
      nextReviewAt: { type: 'string', format: 'date-time' },
      reviewIntervalDays: { type: 'integer' },
    },
  },

  QuizAttempt: {
    type: 'object',
    required: ['attemptNumber', 'score', 'masteryTier', 'completedAt', 'quizVersion'],
    properties: {
      attemptNumber: { type: 'integer' },
      score: { type: 'number' },
      masteryTier: { $ref: '#/components/schemas/QuizMasteryTier' },
      completedAt: { type: 'string', format: 'date-time' },
      quizVersion: { type: 'integer' },
    },
  },

  UserModuleQuizProgress: {
    type: 'object',
    required: ['_id', 'userId', 'courseId', 'moduleIndex', 'attempts', 'bestScore', 'bestTier'],
    properties: {
      _id: { type: 'string' },
      userId: { type: 'string' },
      courseId: { type: 'string' },
      moduleIndex: { type: 'integer' },
      attempts: {
        type: 'array',
        items: { $ref: '#/components/schemas/QuizAttempt' },
      },
      bestScore: { type: 'number' },
      bestTier: nullableRef('#/components/schemas/QuizMasteryTier'),
      reviewIntervalDays: { type: 'integer' },
      consecutiveSuccesses: { type: 'integer' },
      nextReviewAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  CourseQuizProgressItem: {
    type: 'object',
    required: ['moduleIndex', 'bestScore', 'bestTier', 'attemptCount', 'nextReviewAt', 'reviewDue'],
    properties: {
      moduleIndex: { type: 'integer' },
      bestScore: { type: 'number' },
      bestTier: nullableRef('#/components/schemas/QuizMasteryTier'),
      attemptCount: { type: 'integer' },
      nextReviewAt: { type: 'string', format: 'date-time', nullable: true },
      reviewDue: { type: 'boolean' },
    },
  },

  ReviewDueItem: {
    type: 'object',
    required: ['courseId', 'courseSlug', 'courseName', 'moduleIndex', 'moduleName', 'bestScore', 'bestTier', 'nextReviewAt', 'reviewReason'],
    properties: {
      courseId: { type: 'string' },
      courseSlug: { type: 'string', nullable: true },
      courseName: { type: 'string' },
      moduleIndex: { type: 'integer' },
      moduleName: { type: 'string' },
      bestScore: { type: 'number' },
      bestTier: { $ref: '#/components/schemas/QuizMasteryTier' },
      nextReviewAt: { type: 'string', format: 'date-time', nullable: true },
      reviewReason: { $ref: '#/components/schemas/ReviewReason' },
    },
  },

  UnattemptedQuizItem: {
    type: 'object',
    required: ['courseId', 'courseSlug', 'courseName', 'moduleIndex', 'moduleName'],
    properties: {
      courseId: { type: 'string' },
      courseSlug: { type: 'string', nullable: true },
      courseName: { type: 'string' },
      moduleIndex: { type: 'integer' },
      moduleName: { type: 'string' },
    },
  },

  BookmarkedLessonItem: {
    type: 'object',
    required: [
      'courseId',
      'courseName',
      'courseSlug',
      'moduleIndex',
      'lessonIndex',
      'moduleName',
      'lessonName',
      'bookmarkedAt',
    ],
    properties: {
      courseId: { type: 'string' },
      courseName: { type: 'string' },
      courseSlug: { type: 'string', nullable: true },
      moduleIndex: { type: 'integer' },
      lessonIndex: { type: 'integer' },
      moduleName: { type: 'string' },
      lessonName: { type: 'string' },
      bookmarkedAt: { type: 'string', format: 'date-time' },
    },
  },

  RecentActivityItem: {
    type: 'object',
    required: [
      'courseId',
      'courseSlug',
      'courseName',
      'moduleIndex',
      'lessonIndex',
      'moduleName',
      'lessonName',
      'lastAccessedAt',
    ],
    properties: {
      courseId: { type: 'string' },
      courseSlug: { type: 'string', nullable: true },
      courseName: { type: 'string' },
      moduleIndex: { type: 'integer' },
      lessonIndex: { type: 'integer' },
      moduleName: { type: 'string' },
      lessonName: { type: 'string' },
      lastAccessedAt: { type: 'string', format: 'date-time' },
    },
  },

  ChatMessageRole: {
    type: 'string',
    enum: ['user', 'assistant'],
  },

  ChatMessage: {
    type: 'object',
    required: ['role', 'content'],
    properties: {
      role: { $ref: '#/components/schemas/ChatMessageRole' },
      content: { type: 'string' },
    },
  },

  ChatHistoryMessage: {
    type: 'object',
    required: ['role', 'content'],
    properties: {
      role: { $ref: '#/components/schemas/ChatMessageRole' },
      content: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  // ── Socket.io event payloads ─────────────────────────────
  //
  // These events are not tied to any HTTP endpoint, but they are part of
  // the public contract between client and server. Defining them here lets
  // codegen produce shared types so both sides stay in sync. The server
  // side keeps a TypeScript mirror at api/src/types/socketEvents.ts.

  JobStartedEvent: {
    type: 'object',
    required: ['jobId', 'courseId', 'type'],
    properties: {
      jobId: { type: 'string' },
      courseId: { type: 'string' },
      type: { $ref: '#/components/schemas/JobType' },
      moduleIndex: { type: 'integer' },
      lessonIndex: { type: 'integer' },
    },
  },

  JobStatusEvent: {
    type: 'object',
    required: ['jobId', 'status', 'courseId', 'type'],
    properties: {
      jobId: { type: 'string' },
      status: {
        type: 'string',
        enum: ['completed', 'failed'],
        description: 'Terminal status only — progress updates use the job:progress channel.',
      },
      error: { type: 'string', nullable: true },
      errorCode: {
        type: 'string',
        description:
          'Structured error code for failures the client must handle specifically — e.g. INSUFFICIENT_CREDITS triggers the Out-of-Credits modal instead of a toast. Mirrors the value the HTTP error middleware would have returned for a synchronous 4xx.',
      },
      errorMeta: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional metadata that pairs with errorCode (e.g. `{ need, have }` for INSUFFICIENT_CREDITS).',
      },
      courseId: { type: 'string' },
      type: { $ref: '#/components/schemas/JobType' },
      moduleIndex: { type: 'integer' },
      lessonIndex: { type: 'integer' },
    },
  },

  LessonPlaceholderType: {
    type: 'string',
    enum: ['quiz', 'exercise'],
  },

  LessonPlaceholderBlock: {
    type: 'object',
    required: ['id', 'type', 'order'],
    properties: {
      id: { type: 'string' },
      type: { $ref: '#/components/schemas/LessonPlaceholderType' },
      order: { type: 'number' },
    },
  },

  GeneratedRecallCard: {
    type: 'object',
    required: ['kind', 'prompt', 'answer', 'conceptTags', 'sourceBlockId'],
    properties: {
      kind: { $ref: '#/components/schemas/RecallCardKind' },
      prompt: { type: 'string' },
      answer: { type: 'string' },
      conceptTags: { type: 'array', items: { type: 'string' } },
      sourceBlockId: { type: 'string' },
    },
  },

  LessonProgressBlockEvent: {
    type: 'object',
    required: ['type', 'block'],
    properties: {
      type: { type: 'string', enum: ['block'] },
      block: { $ref: '#/components/schemas/LessonBlock' },
    },
  },

  LessonProgressHeroImageEvent: {
    type: 'object',
    required: ['type', 'url'],
    properties: {
      type: { type: 'string', enum: ['hero_image'] },
      url: { type: 'string' },
      s3Key: { type: 'string' },
    },
  },

  LessonProgressContentReadyEvent: {
    type: 'object',
    required: ['type', 'placeholders'],
    properties: {
      type: { type: 'string', enum: ['content_ready'] },
      placeholders: {
        type: 'array',
        items: { $ref: '#/components/schemas/LessonPlaceholderBlock' },
      },
    },
  },

  LessonProgressRecallCardEvent: {
    type: 'object',
    required: ['type', 'card'],
    properties: {
      type: { type: 'string', enum: ['recall_card'] },
      card: { $ref: '#/components/schemas/GeneratedRecallCard' },
    },
  },

  LessonProgressRecallCardsSavedEvent: {
    type: 'object',
    required: ['type', 'count'],
    properties: {
      type: { type: 'string', enum: ['recall_cards_saved'] },
      count: { type: 'integer' },
    },
  },

  LessonProgressNarrationStartedEvent: {
    type: 'object',
    required: ['type'],
    properties: {
      type: { type: 'string', enum: ['narration_started'] },
    },
  },

  LessonProgressNarrationReadyEvent: {
    type: 'object',
    required: ['type', 'cached', 'voiceId'],
    properties: {
      type: { type: 'string', enum: ['narration_ready'] },
      // True when the audio was reused from S3's content-hashed cache
      // (no vendor synthesis happened). Surface this to the user so an
      // instant playback after Clear→Generate doesn't read as broken.
      cached: { type: 'boolean' },
      voiceId: { type: 'string' },
    },
  },

  LessonProgressEvent: {
    oneOf: [
      { $ref: '#/components/schemas/LessonProgressBlockEvent' },
      { $ref: '#/components/schemas/LessonProgressHeroImageEvent' },
      { $ref: '#/components/schemas/LessonProgressContentReadyEvent' },
      { $ref: '#/components/schemas/LessonProgressRecallCardEvent' },
      { $ref: '#/components/schemas/LessonProgressRecallCardsSavedEvent' },
      { $ref: '#/components/schemas/LessonProgressNarrationStartedEvent' },
      { $ref: '#/components/schemas/LessonProgressNarrationReadyEvent' },
    ],
    discriminator: {
      propertyName: 'type',
      mapping: {
        block: '#/components/schemas/LessonProgressBlockEvent',
        hero_image: '#/components/schemas/LessonProgressHeroImageEvent',
        content_ready: '#/components/schemas/LessonProgressContentReadyEvent',
        recall_card: '#/components/schemas/LessonProgressRecallCardEvent',
        recall_cards_saved: '#/components/schemas/LessonProgressRecallCardsSavedEvent',
        narration_started: '#/components/schemas/LessonProgressNarrationStartedEvent',
        narration_ready: '#/components/schemas/LessonProgressNarrationReadyEvent',
      },
    },
  } as unknown as OpenAPIV3.SchemaObject,

  JobProgressEvent: {
    type: 'object',
    required: ['jobId', 'courseId', 'type', 'event'],
    properties: {
      jobId: { type: 'string' },
      courseId: { type: 'string' },
      type: { $ref: '#/components/schemas/JobType' },
      moduleIndex: { type: 'integer' },
      lessonIndex: { type: 'integer' },
      event: { $ref: '#/components/schemas/LessonProgressEvent' },
    },
  },

  CreditsUpdatedEvent: {
    type: 'object',
    required: ['allowance', 'bonus', 'total', 'delta', 'reason'],
    properties: {
      allowance: { type: 'integer' },
      bonus: { type: 'integer' },
      total: { type: 'integer' },
      delta: {
        type: 'integer',
        description: 'Signed delta that caused the update (for nudging UI toast/animation).',
      },
      reason: { $ref: '#/components/schemas/CreditLedgerReason' },
      actionType: {
        type: 'string',
        description: 'Present when reason is debit_action / refund_* — identifies which action spent or refunded.',
      },
    },
  },

  // ── Gamification schemas ─────────────────────────────────

  XpSource: {
    type: 'string',
    enum: [...XP_SOURCES],
  },

  AchievementCategory: {
    type: 'string',
    enum: [...ACHIEVEMENT_CATEGORIES],
  },

  EarnedAchievement: {
    type: 'object',
    required: ['achievementId', 'earnedAt'],
    properties: {
      achievementId: { type: 'string' },
      earnedAt: { type: 'string', format: 'date-time' },
      metadata: { type: 'object', nullable: true, additionalProperties: true },
    },
  },

  XpLogEntry: {
    type: 'object',
    required: ['date', 'xp', 'source'],
    properties: {
      date: { type: 'string' },
      xp: { type: 'number' },
      source: { $ref: '#/components/schemas/XpSource' },
    },
  },

  GamificationProfile: {
    type: 'object',
    required: ['userId', 'totalXp', 'level', 'xpForNextLevel', 'currentStreak', 'longestStreak', 'earnedAchievements'],
    properties: {
      userId: { type: 'string' },
      totalXp: { type: 'number' },
      level: { type: 'integer' },
      xpForNextLevel: { type: 'number' },
      currentStreak: { type: 'integer' },
      longestStreak: { type: 'integer' },
      lastActiveDate: { type: 'string', nullable: true },
      earnedAchievements: {
        type: 'array',
        items: { $ref: '#/components/schemas/EarnedAchievement' },
      },
      activeDates: {
        type: 'array',
        items: { type: 'string' },
      },
      xpLog: {
        type: 'array',
        items: { $ref: '#/components/schemas/XpLogEntry' },
      },
    },
  },

  WeeklySummaryPeriod: {
    type: 'object',
    required: ['xp', 'timeSeconds', 'lessons', 'quizzes', 'recallReviews'],
    properties: {
      xp: { type: 'number' },
      timeSeconds: { type: 'number' },
      lessons: { type: 'integer' },
      quizzes: { type: 'integer' },
      recallReviews: { type: 'integer' },
    },
  },

  XpDaySources: {
    type: 'object',
    required: [
      'lesson_complete',
      'quiz_score',
      'exercise_pass',
      'review_complete',
      'recall_review',
      'recall_mastery',
    ],
    properties: {
      lesson_complete: { type: 'number' },
      quiz_score: { type: 'number' },
      exercise_pass: { type: 'number' },
      review_complete: { type: 'number' },
      recall_review: { type: 'number' },
      recall_mastery: { type: 'number' },
    },
  },

  XpDayEntry: {
    type: 'object',
    required: ['date', 'xp', 'sources'],
    properties: {
      date: { type: 'string' },
      xp: { type: 'number' },
      sources: { $ref: '#/components/schemas/XpDaySources' },
    },
  },

  XpWeekEntry: {
    type: 'object',
    required: ['week', 'xp'],
    properties: {
      week: { type: 'string' },
      xp: { type: 'number' },
    },
  },

  GamificationStats: {
    type: 'object',
    required: ['xpByDay', 'xpByWeek', 'totalTimeLearned', 'lessonsThisWeek', 'weeklySummary'],
    properties: {
      xpByDay: {
        type: 'array',
        items: { $ref: '#/components/schemas/XpDayEntry' },
      },
      xpByWeek: {
        type: 'array',
        items: { $ref: '#/components/schemas/XpWeekEntry' },
      },
      totalTimeLearned: { type: 'number' },
      lessonsThisWeek: { type: 'integer' },
      weeklySummary: {
        type: 'object',
        required: ['thisWeek', 'lastWeek'],
        properties: {
          thisWeek: { $ref: '#/components/schemas/WeeklySummaryPeriod' },
          lastWeek: { $ref: '#/components/schemas/WeeklySummaryPeriod' },
        },
      },
    },
  },

  QuizTrendsAttempt: {
    type: 'object',
    required: ['date', 'score', 'courseId', 'courseName', 'moduleName', 'moduleIndex'],
    properties: {
      date: { type: 'string' },
      score: { type: 'number' },
      courseId: { type: 'string' },
      courseName: { type: 'string' },
      moduleName: { type: 'string' },
      moduleIndex: { type: 'integer' },
    },
  },

  QuizTrendsResult: {
    type: 'object',
    required: ['attempts', 'averageScore', 'recentTrend'],
    properties: {
      attempts: {
        type: 'array',
        items: { $ref: '#/components/schemas/QuizTrendsAttempt' },
      },
      averageScore: { type: 'number' },
      recentTrend: { type: 'number' },
    },
  },

  Course: {
    type: 'object',
    required: ['_id', 'userId', 'name', 'slug', 'status', 'goal', 'createdAt', 'updatedAt'],
    properties: {
      _id: { type: 'string' },
      userId: { type: 'string' },
      name: { type: 'string' },
      slug: { type: 'string', nullable: true },
      status: { $ref: '#/components/schemas/CourseStatus' },
      goal: { type: 'string' },
      domain: nullableRef('#/components/schemas/CourseDomain'),
      goalType: nullableRef('#/components/schemas/GoalType'),
      goalTypeConfidence: nullableRef('#/components/schemas/GoalTypeConfidence'),
      goalTypeConfirmedAt: { type: 'string', format: 'date-time', nullable: true },
      clarifyData: { $ref: '#/components/schemas/ClarifyResponse' },
      answers: { type: 'object' },
      depth: { $ref: '#/components/schemas/CourseDepth' },
      depthPreviews: { $ref: '#/components/schemas/DepthPreviewsResponse' },
      structure: { $ref: '#/components/schemas/GenerateStructureResponse' },
      feedbackHistory: { type: 'array', items: { type: 'string' } },
      pendingFeedback: { type: 'string' },
      currentStep: { type: 'number' },
      activeJobId: { type: 'string' },
      activeLesson: {
        type: 'object',
        nullable: true,
        required: ['moduleIndex', 'lessonIndex'],
        properties: {
          moduleIndex: { type: 'number' },
          lessonIndex: { type: 'number' },
        },
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  // ── Recall schemas ────────────────────────────────────────

  RecallCardKind: {
    type: 'string',
    enum: [...RECALL_CARD_KINDS],
  },

  RecallMode: {
    type: 'string',
    enum: [...RECALL_MODES],
  },

  RecallState: {
    type: 'string',
    enum: [...RECALL_STATES],
  },

  RecallRating: {
    type: 'integer',
    enum: [...RECALL_RATINGS],
    description: '1=Again, 2=Hard, 3=Good, 4=Easy',
  },

  RecallQueueItem: {
    type: 'object',
    required: [
      'recallCardId', 'courseId', 'courseSlug', 'courseName', 'lessonId',
      'moduleIndex', 'lessonIndex', 'lessonName', 'moduleName',
      'kind', 'prompt', 'answer', 'conceptTags', 'sourceBlockId',
      'isNew', 'mode', 'box', 'dueAt',
    ],
    properties: {
      recallCardId: { type: 'string' },
      courseId: { type: 'string' },
      courseSlug: { type: 'string', nullable: true },
      courseName: { type: 'string' },
      lessonId: { type: 'string' },
      moduleIndex: { type: 'integer' },
      lessonIndex: { type: 'integer' },
      lessonName: { type: 'string' },
      moduleName: { type: 'string' },
      kind: { $ref: '#/components/schemas/RecallCardKind' },
      prompt: { type: 'string' },
      answer: { type: 'string' },
      conceptTags: { type: 'array', items: { type: 'string' } },
      sourceBlockId: { type: 'string' },
      isNew: { type: 'boolean' },
      mode: { $ref: '#/components/schemas/RecallMode' },
      box: { type: 'integer' },
      dueAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  RecallQueue: {
    type: 'object',
    required: ['due', 'fresh', 'counts'],
    properties: {
      due: {
        type: 'array',
        items: { $ref: '#/components/schemas/RecallQueueItem' },
      },
      fresh: {
        type: 'array',
        items: { $ref: '#/components/schemas/RecallQueueItem' },
      },
      counts: {
        type: 'object',
        required: ['dueTotal', 'freshAvailable', 'learned'],
        properties: {
          dueTotal: { type: 'integer' },
          freshAvailable: { type: 'integer' },
          learned: { type: 'integer' },
        },
      },
    },
  },

  RateRecallResult: {
    type: 'object',
    required: ['box', 'state', 'reps', 'lapses', 'nextDue', 'lastReview'],
    properties: {
      box: { type: 'integer' },
      state: { $ref: '#/components/schemas/RecallState' },
      reps: { type: 'integer' },
      lapses: { type: 'integer' },
      nextDue: { type: 'string', format: 'date-time' },
      lastReview: { type: 'string', format: 'date-time', nullable: true },
      masteredAt: { type: 'string', format: 'date-time', nullable: true },
      justMastered: {
        type: 'boolean',
        description: 'True exactly once per recall card, when this rating first reached Leitner box 4. Never true on re-mastery.',
      },
    },
  },

  GradeVerdict: {
    type: 'string',
    enum: ['correct', 'partial', 'incorrect'],
  },

  GradeResult: {
    type: 'object',
    required: ['score', 'verdict', 'feedback'],
    properties: {
      score: { type: 'number', minimum: 0, maximum: 1 },
      verdict: { $ref: '#/components/schemas/GradeVerdict' },
      feedback: { type: 'string' },
    },
  },

  RecallStats: {
    type: 'object',
    required: [
      'totalCards', 'totalReviewed', 'totalMastered',
      'reviewedThisWeek', 'reviewedLastWeek',
      'dueToday', 'dueThisWeek',
      'boxDistribution', 'recentHistory',
    ],
    properties: {
      totalCards: { type: 'integer' },
      totalReviewed: { type: 'integer' },
      totalMastered: { type: 'integer', description: 'Recall cards that reached Leitner box 4 at least once (masteredAt !== null)' },
      reviewedThisWeek: { type: 'integer' },
      reviewedLastWeek: { type: 'integer' },
      dueToday: { type: 'integer' },
      dueThisWeek: { type: 'integer' },
      boxDistribution: {
        type: 'array',
        items: {
          type: 'object',
          required: ['box', 'count'],
          properties: {
            box: { type: 'integer' },
            count: { type: 'integer' },
          },
        },
      },
      recentHistory: {
        type: 'array',
        items: {
          type: 'object',
          required: ['date', 'reviews', 'avgRating'],
          properties: {
            date: { type: 'string' },
            reviews: { type: 'integer' },
            avgRating: { type: 'number' },
          },
        },
      },
    },
  },

  // ── Usage ledger ─────────────────────────────────────────

  UsageEvent: {
    type: 'object',
    required: [
      'id',
      'timestamp',
      'service',
      'action',
      'costMicroCents',
      'chargedMicroCents',
      'creditsCharged',
      'planAtTime',
      'source',
      'userPaidUsd',
      'metadata',
    ],
    properties: {
      id: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
      service: { $ref: '#/components/schemas/UsageService' },
      action: { type: 'string' },
      // Vendor cost — what we paid the provider (real API spend).
      costMicroCents: { type: 'integer' },
      // What we charged the user (vendor cost × any per-service markup).
      // Equal to costMicroCents for services without markup.
      chargedMicroCents: { type: 'integer' },
      // Decimal credits this row was worth (chargedMicroCents / MICROCENTS_PER_CREDIT).
      // Decimal — no per-row ceil, see controller note.
      creditsCharged: { type: 'number' },
      // The user's plan when the row was recorded; null for legacy rows or
      // for events recorded outside an authenticated/job scope.
      planAtTime: nullableRef('#/components/schemas/PlanKey'),
      // Dominant balance source for the row's pro-rated debit, or null when
      // no debit row is associated yet (job in flight / failed).
      source: {
        type: 'string',
        enum: ['allowance', 'topup', 'mixed'],
        nullable: true,
      },
      // Pro-rated dollars the user effectively paid for this row. null when
      // no debit attribution is available.
      userPaidUsd: { type: 'number', nullable: true },
      metadata: { type: 'object', additionalProperties: true },
    },
  },

  UsageHistory: {
    type: 'object',
    required: ['events', 'total', 'limit', 'offset', 'hasMore'],
    properties: {
      events: {
        type: 'array',
        items: { $ref: '#/components/schemas/UsageEvent' },
      },
      total: { type: 'integer' },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
      hasMore: { type: 'boolean' },
    },
  },

  UsageCostBucket: {
    type: 'object',
    required: ['costMicroCents', 'chargedMicroCents', 'creditsDebited'],
    properties: {
      costMicroCents: { type: 'integer' },
      chargedMicroCents: { type: 'integer' },
      // Net credits actually debited from the user's balance in the period
      // (sum of -delta over CreditLedger rows with reason='debit_action').
      // Differs from `microCentsToCredits(chargedMicroCents)` because real
      // debits ceil per-job, not per-row, and clamp at the user's remaining
      // balance.
      creditsDebited: { type: 'integer' },
    },
  },

  UsageServiceTotal: {
    type: 'object',
    required: ['service', 'costMicroCents', 'chargedMicroCents'],
    properties: {
      service: { $ref: '#/components/schemas/UsageService' },
      costMicroCents: { type: 'integer' },
      chargedMicroCents: { type: 'integer' },
    },
  },

  UsageSummary: {
    type: 'object',
    required: ['today', 'thisMonth', 'allTime', 'byService'],
    properties: {
      today: { $ref: '#/components/schemas/UsageCostBucket' },
      thisMonth: { $ref: '#/components/schemas/UsageCostBucket' },
      allTime: { $ref: '#/components/schemas/UsageCostBucket' },
      byService: {
        type: 'array',
        items: { $ref: '#/components/schemas/UsageServiceTotal' },
      },
    },
  },

  // ── Generic ack response ─────────────────────────────────

  OkResponse: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean' },
    },
  },

  // ── Usage sort enums ─────────────────────────────────────
  // Surfaced as named schemas so the client can derive these
  // string-literal unions from `@/api/types` instead of
  // redeclaring them locally (CLAUDE.md "no local enum types"
  // rule).

  UsageSortField: {
    type: 'string',
    enum: ['timestamp', 'costMicroCents', 'chargedMicroCents', 'service'],
  },

  UsageSortDir: {
    type: 'string',
    enum: ['asc', 'desc'],
  },

  // ── Lesson-mentor chat ───────────────────────────────────

  LessonChatHistoryAttachmentRef: {
    type: 'object',
    required: ['attachmentId'],
    properties: {
      attachmentId: { type: 'string' },
    },
  },

  MentorChatHandoff: {
    type: 'object',
    required: ['target', 'label'],
    properties: {
      target: { type: 'string', enum: ['quiz', 'recall', 'lesson'] },
      moduleIndex: { type: 'integer' },
      lessonIndex: { type: 'integer' },
      label: { type: 'string' },
    },
    description:
      'A successful emit_handoff result persisted alongside the assistant message that produced it. Used by the client to re-render the inline button on history reload.',
  },

  LessonChatHistoryMessage: {
    type: 'object',
    required: ['role', 'content'],
    properties: {
      role: { type: 'string' },
      content: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      attachments: {
        type: 'array',
        items: { $ref: '#/components/schemas/LessonChatHistoryAttachmentRef' },
      },
      handoffs: {
        type: 'array',
        items: { $ref: '#/components/schemas/MentorChatHandoff' },
      },
    },
  },

  LessonChatAttachmentMeta: {
    type: 'object',
    required: ['id', 'filename', 'kind', 'approxTokens'],
    properties: {
      id: { type: 'string' },
      filename: { type: 'string' },
      kind: { type: 'string', enum: ['pdf', 'text'] },
      approxTokens: { type: 'integer' },
    },
  },

  LessonChatHistoryResponse: {
    type: 'object',
    required: ['messages', 'attachmentsById', 'suggestedPrompts', 'lessonGenerated'],
    properties: {
      messages: {
        type: 'array',
        items: { $ref: '#/components/schemas/LessonChatHistoryMessage' },
      },
      attachmentsById: {
        type: 'object',
        additionalProperties: { $ref: '#/components/schemas/LessonChatAttachmentMeta' },
        description:
          'Lookup by attachment id. The full extracted text is server-only — only metadata reaches the client.',
      },
      suggestedPrompts: {
        type: 'array',
        items: { type: 'string' },
      },
      lessonGenerated: {
        type: 'boolean',
        description: 'True once the lesson content has been generated and persisted.',
      },
    },
  },

  // ── Course-mentor chat (compass) ─────────────────────────

  CourseMentorHistoryMessage: {
    type: 'object',
    required: ['role', 'content'],
    properties: {
      role: { type: 'string' },
      content: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      handoffs: {
        type: 'array',
        items: { $ref: '#/components/schemas/MentorChatHandoff' },
      },
    },
  },

  CourseMentorHistoryResponse: {
    type: 'object',
    required: ['messages', 'suggestedPrompts', 'courseGenerated', 'hasAnyLessonContent'],
    properties: {
      messages: {
        type: 'array',
        items: { $ref: '#/components/schemas/CourseMentorHistoryMessage' },
      },
      suggestedPrompts: {
        type: 'array',
        items: { type: 'string' },
      },
      courseGenerated: {
        type: 'boolean',
        description:
          "True once the course structure exists and is in 'ready' status. Drives the panel's empty state.",
      },
      hasAnyLessonContent: {
        type: 'boolean',
        description: 'True if at least one lesson in the course has had its content generated.',
      },
    },
  },

  // ── Security actions (sensitive-action OTP gate) ─────────

  SecurityAction: {
    type: 'string',
    enum: [...SECURITY_ACTIONS],
    description:
      'Sensitive account-state action that requires a fresh email-delivered 6-digit code in addition to the bearer token.',
  },

  // ── Depth-override 409 payloads ──────────────────────────
  //
  // Bidirectional gate on PATCH /api/course/{id}: the controller emits one
  // of two `code` values depending on which side fired. Modelled as separate
  // named schemas so both server-side JSDoc references and client-side
  // discriminated unions are anchored on the same shapes.

  DepthOverrideRiskLevel: {
    type: 'string',
    enum: ['low', 'moderate', 'high'],
  },

  DepthOverrideOvercommitPayload: {
    type: 'object',
    required: ['code', 'message', 'recommended', 'selectedDepth'],
    description:
      'Selected depth is likely too big for what the learner answered (overcommit). Returned with HTTP 409.',
    properties: {
      code: { type: 'string', enum: ['DEPTH_OVERRIDE_REQUIRES_ACK'] },
      message: { type: 'string' },
      recommended: nullableRef('#/components/schemas/CourseDepth'),
      selectedDepth: { $ref: '#/components/schemas/CourseDepth' },
      lessonCountRange: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description: '[min, max] estimated lesson count for the selected depth.',
      },
      estimatedHoursRange: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description: '[min, max] estimated learner-facing hours for the selected depth.',
      },
      softnessCues: { type: 'array', items: { type: 'string' } },
      finishPressureCues: { type: 'array', items: { type: 'string' } },
      overcommitRisk: { $ref: '#/components/schemas/DepthOverrideRiskLevel' },
      overcommitRationale: { type: 'string' },
    },
  },

  DepthOverrideUndercommitPayload: {
    type: 'object',
    required: ['code', 'message', 'recommended', 'selectedDepth'],
    description:
      'Selected depth is below the recommended tier and the LLM judged the coverage gap meaningful (undercommit). Returned with HTTP 409.',
    properties: {
      code: { type: 'string', enum: ['DEPTH_UNDERCOMMIT_REQUIRES_ACK'] },
      message: { type: 'string' },
      recommended: nullableRef('#/components/schemas/CourseDepth'),
      selectedDepth: { $ref: '#/components/schemas/CourseDepth' },
      lessonCountRange: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description: '[min, max] estimated lesson count for the selected depth (what the learner will get).',
      },
      estimatedHoursRange: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description: '[min, max] estimated learner-facing hours for the selected depth.',
      },
      recommendedLessonCountRange: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description: '[min, max] estimated lesson count for the recommended depth (what they would have gotten).',
      },
      recommendedEstimatedHoursRange: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description: '[min, max] estimated learner-facing hours for the recommended depth.',
      },
      undercommitRisk: { $ref: '#/components/schemas/DepthOverrideRiskLevel' },
      undercommitRationale: { type: 'string' },
    },
  },

  DepthOverridePayload: {
    oneOf: [
      { $ref: '#/components/schemas/DepthOverrideOvercommitPayload' },
      { $ref: '#/components/schemas/DepthOverrideUndercommitPayload' },
    ],
    discriminator: {
      propertyName: 'code',
      mapping: {
        DEPTH_OVERRIDE_REQUIRES_ACK: '#/components/schemas/DepthOverrideOvercommitPayload',
        DEPTH_UNDERCOMMIT_REQUIRES_ACK: '#/components/schemas/DepthOverrideUndercommitPayload',
      },
    },
  } as unknown as OpenAPIV3.SchemaObject,

  // ── Mentor attachment ────────────────────────────────────

  MentorAttachmentResponse: {
    type: 'object',
    required: ['id', 'filename', 'kind', 'approxTokens', 'dedupedFromExisting'],
    properties: {
      id: { type: 'string' },
      filename: { type: 'string' },
      kind: { type: 'string', enum: ['pdf', 'text'] },
      approxTokens: { type: 'integer' },
      dedupedFromExisting: {
        type: 'boolean',
        description: 'True when this exact file (sha256 match) was already on the session.',
      },
    },
  },
};
