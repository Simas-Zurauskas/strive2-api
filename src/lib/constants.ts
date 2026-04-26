// ── Course ────────────────────────────────────────────────

export const COURSE_DEPTHS = ['overview', 'comprehensive', 'deep_dive'] as const;
export type CourseDepth = (typeof COURSE_DEPTHS)[number];

export const COURSE_STATUSES = ['creating', 'ready', 'archived'] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

export const COURSE_DOMAINS = [
  'programming',
  'stem',
  'humanities',
  'language',
  'creative',
  'business',
  'practical',
  'life-skills',
  'other',
] as const;
export type CourseDomain = (typeof COURSE_DOMAINS)[number];

// ── Jobs ──────────────────────────────────────────────────

export const JOB_TYPES = ['clarify', 'generate_structure', 'refine_structure', 'generate_lesson', 'generate_depth_previews', 'generate_module_quiz', 'regenerate_hero', 'regenerate_links', 'lesson_narration'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// ── Questions ─────────────────────────────────────────────

export const QUESTION_TYPES = ['multiple_choice', 'multiple_select', 'text'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

// ── Chat ─────────────────────────────────────────────────

export const CHAT_ROLES = ['user', 'assistant'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

// ── Progress ─────────────────────────────────────────────

export const LESSON_PROGRESS_STATUSES = ['not_started', 'in_progress', 'completed'] as const;
export type LessonProgressStatus = (typeof LESSON_PROGRESS_STATUSES)[number];

// ── Module Quiz ─────────────────────────────────────────

export const QUIZ_MASTERY_TIERS = ['needs_review', 'passed', 'mastered'] as const;
export type QuizMasteryTier = (typeof QUIZ_MASTERY_TIERS)[number];

// ── Spaced Review ───────────────────────────────────────

export const REVIEW_INITIAL_INTERVALS: Record<QuizMasteryTier, number> = {
  mastered: 7,
  passed: 3,
  needs_review: 1,
};

export const REVIEW_PROGRESSION_GAPS: Record<QuizMasteryTier, number> = {
  needs_review: 1,
  passed: 2,
  mastered: 3,
};

export const REVIEW_MAX_INTERVAL_DAYS = 90;
export const REVIEW_MIN_INTERVAL_DAYS = 1;

// ── Auth ──────────────────────────────────────────────────

export const AUTH_PROVIDERS = ['GOOGLE', 'CREDENTIALS'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export const AuthProvider = {
  GOOGLE: 'GOOGLE',
  CREDENTIALS: 'CREDENTIALS',
} as const satisfies Record<string, AuthProvider>;
