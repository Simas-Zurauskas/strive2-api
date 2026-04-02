// ── Course ────────────────────────────────────────────────

export const COURSE_DEPTHS = ['overview', 'comprehensive', 'deep_dive'] as const;
export type CourseDepth = (typeof COURSE_DEPTHS)[number];

export const COURSE_STATUSES = ['creating', 'ready', 'archived'] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

// ── Jobs ──────────────────────────────────────────────────

export const JOB_TYPES = ['clarify', 'generate_structure', 'refine_structure', 'generate_lesson', 'generate_depth_previews'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// ── Questions ─────────────────────────────────────────────

export const QUESTION_TYPES = ['multiple_choice', 'multiple_select', 'text'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

// ── Chat ─────────────────────────────────────────────────

export const CHAT_ROLES = ['user', 'assistant'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

// ── Auth ──────────────────────────────────────────────────

export const AUTH_PROVIDERS = ['GOOGLE', 'CREDENTIALS'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export const AuthProvider = {
  GOOGLE: 'GOOGLE',
  CREDENTIALS: 'CREDENTIALS',
} as const satisfies Record<string, AuthProvider>;
