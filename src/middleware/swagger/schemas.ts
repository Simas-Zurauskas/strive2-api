import { OpenAPIV3 } from 'openapi-types';
import { ERROR_CODES } from '@middleware/errorMiddleware';
import { AUTH_PROVIDERS, COURSE_DEPTHS, COURSE_STATUSES, JOB_TYPES, JOB_STATUSES, LESSON_PROGRESS_STATUSES, QUESTION_TYPES, QUIZ_MASTERY_TIERS } from '@lib/constants';
import { ACHIEVEMENT_CATEGORIES, XP_SOURCES } from '@lib/gamificationConstants';
import { BLOCK_TYPES } from '@models/LessonContentModel';

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

  // ── Object schemas ───────────────────────────────────────

  ApiError: {
    type: 'object',
    required: ['message'],
    properties: {
      message: { type: 'string' },
      errorCode: { $ref: '#/components/schemas/ErrorCode' },
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

  AuthorisedUser: {
    type: 'object',
    required: ['_id', 'email', 'emailVerified', 'authProviders', 'createdAt', 'updatedAt'],
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
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
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
    required: ['userId', 'totalXp', 'level', 'xpForNextLevel', 'currentStreak', 'longestStreak', 'streakFreezeAvailable', 'earnedAchievements'],
    properties: {
      userId: { type: 'string' },
      totalXp: { type: 'number' },
      level: { type: 'integer' },
      xpForNextLevel: { type: 'number' },
      currentStreak: { type: 'integer' },
      longestStreak: { type: 'integer' },
      lastActiveDate: { type: 'string', nullable: true },
      streakFreezeAvailable: { type: 'integer' },
      streakFreezeUsedDates: { type: 'array', items: { type: 'string' } },
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
      clarifyData: { $ref: '#/components/schemas/ClarifyResponse' },
      answers: { type: 'object' },
      depth: { $ref: '#/components/schemas/CourseDepth' },
      depthPreviews: { $ref: '#/components/schemas/DepthPreviewsResponse' },
      structure: { $ref: '#/components/schemas/GenerateStructureResponse' },
      feedbackHistory: { type: 'array', items: { type: 'string' } },
      pendingFeedback: { type: 'string' },
      currentStep: { type: 'number' },
      activeJobId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
};
