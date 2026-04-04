import type { ICourse } from '@models/CourseModel';
import type { CourseDepth, QuestionType } from '@lib/constants';

// ── Persona (orchestrator-only) ──────────────────────────

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
  };
}

export interface OrchestratorConfig {
  apiUrl: string;
  concurrency: number;
  email: string;
  password: string;
  outputDir: string;
  enableChatReview: boolean;
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
  'name' | 'goal' | 'status' | 'clarifyData' | 'answers' | 'depth' | 'depthPreviews' | 'structure' | 'feedbackHistory'
> & { _id: string };

// Re-export for convenience
export type { CourseDepth };
export type { ILessonContent, ILessonBlock } from '@models/LessonContentModel';
