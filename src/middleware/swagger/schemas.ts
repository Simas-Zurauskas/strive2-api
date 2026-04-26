import { OpenAPIV3 } from 'openapi-types';
import { ERROR_CODES } from '@middleware/errorMiddleware';
import { AUTH_PROVIDERS, COURSE_DEPTHS, COURSE_DOMAINS, COURSE_STATUSES, JOB_TYPES, JOB_STATUSES, LESSON_PROGRESS_STATUSES, QUESTION_TYPES, QUIZ_MASTERY_TIERS } from '@lib/constants';
import { ACHIEVEMENT_CATEGORIES, XP_SOURCES } from '@lib/gamificationConstants';
import { BLOCK_TYPES } from '@models/LessonContentModel';
import { INSIGHT_KINDS, INSIGHT_MODES, INSIGHT_RATINGS, INSIGHT_STATES } from '@lib/insightConstants';
import { USAGE_SERVICES } from '@lib/usageConstants';
import { CREDIT_LEDGER_REASONS } from '@models/CreditLedgerModel';

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

  GeneratedInsight: {
    type: 'object',
    required: ['kind', 'prompt', 'answer', 'conceptTags', 'sourceBlockId'],
    properties: {
      kind: { $ref: '#/components/schemas/InsightKind' },
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

  LessonProgressInsightEvent: {
    type: 'object',
    required: ['type', 'insight'],
    properties: {
      type: { type: 'string', enum: ['insight'] },
      insight: { $ref: '#/components/schemas/GeneratedInsight' },
    },
  },

  LessonProgressInsightsSavedEvent: {
    type: 'object',
    required: ['type', 'count'],
    properties: {
      type: { type: 'string', enum: ['insights_saved'] },
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
      { $ref: '#/components/schemas/LessonProgressInsightEvent' },
      { $ref: '#/components/schemas/LessonProgressInsightsSavedEvent' },
      { $ref: '#/components/schemas/LessonProgressNarrationStartedEvent' },
      { $ref: '#/components/schemas/LessonProgressNarrationReadyEvent' },
    ],
    discriminator: {
      propertyName: 'type',
      mapping: {
        block: '#/components/schemas/LessonProgressBlockEvent',
        hero_image: '#/components/schemas/LessonProgressHeroImageEvent',
        content_ready: '#/components/schemas/LessonProgressContentReadyEvent',
        insight: '#/components/schemas/LessonProgressInsightEvent',
        insights_saved: '#/components/schemas/LessonProgressInsightsSavedEvent',
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
    required: ['xp', 'timeSeconds', 'lessons', 'quizzes', 'insights'],
    properties: {
      xp: { type: 'number' },
      timeSeconds: { type: 'number' },
      lessons: { type: 'integer' },
      quizzes: { type: 'integer' },
      insights: { type: 'integer' },
    },
  },

  XpDaySources: {
    type: 'object',
    required: [
      'lesson_complete',
      'quiz_score',
      'exercise_pass',
      'review_complete',
      'insight_review',
      'insight_mastery',
    ],
    properties: {
      lesson_complete: { type: 'number' },
      quiz_score: { type: 'number' },
      exercise_pass: { type: 'number' },
      review_complete: { type: 'number' },
      insight_review: { type: 'number' },
      insight_mastery: { type: 'number' },
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

  // ── Insights schemas ──────────────────────────────────────

  InsightKind: {
    type: 'string',
    enum: [...INSIGHT_KINDS],
  },

  InsightMode: {
    type: 'string',
    enum: [...INSIGHT_MODES],
  },

  InsightState: {
    type: 'string',
    enum: [...INSIGHT_STATES],
  },

  InsightRating: {
    type: 'integer',
    enum: [...INSIGHT_RATINGS],
    description: '1=Again, 2=Hard, 3=Good, 4=Easy',
  },

  InsightQueueItem: {
    type: 'object',
    required: [
      'insightId', 'courseId', 'courseSlug', 'courseName', 'lessonId',
      'moduleIndex', 'lessonIndex', 'lessonName', 'moduleName',
      'kind', 'prompt', 'answer', 'conceptTags', 'sourceBlockId',
      'isNew', 'mode', 'box', 'dueAt',
    ],
    properties: {
      insightId: { type: 'string' },
      courseId: { type: 'string' },
      courseSlug: { type: 'string', nullable: true },
      courseName: { type: 'string' },
      lessonId: { type: 'string' },
      moduleIndex: { type: 'integer' },
      lessonIndex: { type: 'integer' },
      lessonName: { type: 'string' },
      moduleName: { type: 'string' },
      kind: { $ref: '#/components/schemas/InsightKind' },
      prompt: { type: 'string' },
      answer: { type: 'string' },
      conceptTags: { type: 'array', items: { type: 'string' } },
      sourceBlockId: { type: 'string' },
      isNew: { type: 'boolean' },
      mode: { $ref: '#/components/schemas/InsightMode' },
      box: { type: 'integer' },
      dueAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  InsightQueue: {
    type: 'object',
    required: ['due', 'fresh', 'counts'],
    properties: {
      due: {
        type: 'array',
        items: { $ref: '#/components/schemas/InsightQueueItem' },
      },
      fresh: {
        type: 'array',
        items: { $ref: '#/components/schemas/InsightQueueItem' },
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

  RateInsightResult: {
    type: 'object',
    required: ['box', 'state', 'reps', 'lapses', 'nextDue', 'lastReview'],
    properties: {
      box: { type: 'integer' },
      state: { $ref: '#/components/schemas/InsightState' },
      reps: { type: 'integer' },
      lapses: { type: 'integer' },
      nextDue: { type: 'string', format: 'date-time' },
      lastReview: { type: 'string', format: 'date-time', nullable: true },
      masteredAt: { type: 'string', format: 'date-time', nullable: true },
      justMastered: {
        type: 'boolean',
        description: 'True exactly once per insight, when this rating first reached Leitner box 4. Never true on re-mastery.',
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

  InsightStats: {
    type: 'object',
    required: [
      'totalInsights', 'totalReviewed', 'totalMastered',
      'reviewedThisWeek', 'reviewedLastWeek',
      'dueToday', 'dueThisWeek',
      'boxDistribution', 'recentHistory',
    ],
    properties: {
      totalInsights: { type: 'integer' },
      totalReviewed: { type: 'integer' },
      totalMastered: { type: 'integer', description: 'Insights that reached Leitner box 4 at least once (masteredAt !== null)' },
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
    required: ['costMicroCents', 'chargedMicroCents'],
    properties: {
      costMicroCents: { type: 'integer' },
      chargedMicroCents: { type: 'integer' },
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
};
