import { OpenAPIV3 } from 'openapi-types';
import { ERROR_CODES } from '@middleware/errorMiddleware';
import { AUTH_PROVIDERS, COURSE_DEPTHS, COURSE_DOMAINS, COURSE_STATUSES, JOB_TYPES, JOB_STATUSES, LESSON_PROGRESS_STATUSES, QUESTION_TYPES, QUIZ_MASTERY_TIERS } from '@lib/constants';
import { ACHIEVEMENT_CATEGORIES, XP_SOURCES } from '@lib/gamificationConstants';
import { BLOCK_TYPES } from '@models/LessonContentModel';
import { INSIGHT_KINDS, INSIGHT_MODES, INSIGHT_RATINGS, INSIGHT_STATES } from '@lib/insightConstants';
import { USAGE_SERVICES } from '@lib/usageConstants';

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
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  BillingPlan: {
    type: 'object',
    required: [
      'key',
      'displayName',
      'monthlyUsd',
      'annualMonthlyUsd',
      'annualUsd',
      'monthlyAllowance',
      'maxConcurrentJobs',
    ],
    properties: {
      key: { $ref: '#/components/schemas/PlanKey' },
      displayName: { type: 'string' },
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
      reason: {
        type: 'string',
        enum: [
          'signup_grant',
          'period_reset',
          'plan_upgrade_bonus',
          'topup_purchase',
          'debit_action',
          'refund_job_failed',
          'refund_job_canceled',
          'refund_cross_period',
          'admin_grant',
          'admin_clawback',
        ],
      },
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
      summary: { type: 'string', nullable: true },
      version: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
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

  GamificationStats: {
    type: 'object',
    required: ['xpByDay', 'xpByWeek', 'totalTimeLearned', 'lessonsThisWeek'],
    properties: {
      xpByDay: {
        type: 'array',
        items: {
          type: 'object',
          required: ['date', 'xp'],
          properties: {
            date: { type: 'string' },
            xp: { type: 'number' },
          },
        },
      },
      xpByWeek: {
        type: 'array',
        items: {
          type: 'object',
          required: ['week', 'xp'],
          properties: {
            week: { type: 'string' },
            xp: { type: 'number' },
          },
        },
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
    required: ['id', 'timestamp', 'service', 'action', 'costMicroCents', 'metadata'],
    properties: {
      id: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
      service: { $ref: '#/components/schemas/UsageService' },
      action: { type: 'string' },
      costMicroCents: { type: 'integer' },
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
    required: ['costMicroCents'],
    properties: {
      costMicroCents: { type: 'integer' },
    },
  },

  UsageServiceTotal: {
    type: 'object',
    required: ['service', 'costMicroCents'],
    properties: {
      service: { $ref: '#/components/schemas/UsageService' },
      costMicroCents: { type: 'integer' },
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
