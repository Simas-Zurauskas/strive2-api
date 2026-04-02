import { OpenAPIV3 } from 'openapi-types';
import { ERROR_CODES } from '@middleware/errorMiddleware';
import { AUTH_PROVIDERS, COURSE_DEPTHS, COURSE_STATUSES, JOB_TYPES, JOB_STATUSES, QUESTION_TYPES } from '@lib/constants';
import { BLOCK_TYPES } from '@models/LessonContentModel';

type SchemaMap = Record<string, OpenAPIV3.SchemaObject>;

export const schemas: SchemaMap = {
  ApiError: {
    type: 'object',
    required: ['message'],
    properties: {
      message: { type: 'string' },
      errorCode: { type: 'string', enum: [...ERROR_CODES] },
    },
  },

  AuthProvider: {
    type: 'object',
    required: ['provider'],
    properties: {
      provider: { type: 'string', enum: [...AUTH_PROVIDERS] },
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
      type: { type: 'string', enum: [...QUESTION_TYPES] },
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
      recommended: { type: 'string', enum: [...COURSE_DEPTHS] },
      recommendationReason: { type: 'string' },
    },
  },

  JobStatus: {
    type: 'object',
    required: ['status', 'type', 'courseId'],
    properties: {
      status: { type: 'string', enum: [...JOB_STATUSES] },
      type: { type: 'string', enum: [...JOB_TYPES] },
      courseId: { type: 'string' },
      error: { type: 'string' },
    },
  },

  LessonBlock: {
    type: 'object',
    required: ['id', 'type', 'content', 'order'],
    properties: {
      id: { type: 'string' },
      type: { type: 'string', enum: [...BLOCK_TYPES] },
      content: { type: 'string' },
      metadata: { type: 'object', nullable: true },
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
      audioUrl: { type: 'string', nullable: true },
      summary: { type: 'string', nullable: true },
      version: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  Course: {
    type: 'object',
    required: ['_id', 'userId', 'name', 'status', 'goal', 'createdAt', 'updatedAt'],
    properties: {
      _id: { type: 'string' },
      userId: { type: 'string' },
      name: { type: 'string' },
      status: { type: 'string', enum: [...COURSE_STATUSES] },
      goal: { type: 'string' },
      clarifyData: { $ref: '#/components/schemas/ClarifyResponse' },
      answers: { type: 'object' },
      depth: { type: 'string', enum: [...COURSE_DEPTHS] },
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
