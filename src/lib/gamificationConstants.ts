// ── XP Values ──────────────────────────────────────────────

export const XP_VALUES = {
  LESSON_COMPLETE: 50,
  QUIZ_SCORE_MULTIPLIER: 2, // score (0-100) * multiplier = 0-200 XP
  EXERCISE_PASS: 30,
  REVIEW_COMPLETE: 40,
} as const;

// ── Levels ─────────────────────────────────────────────────

const LEVEL_THRESHOLDS = [
  0, 100, 250, 450, 700, 1000, 1400, 1900, 2500, 3200, // 1-10
  4000, 5000, 6200, 7600, 9200, 11000, 13000, 15500, 18500, 22000, // 11-20
  26000, 30500, 35500, 41000, 47000, // 21-25
] as const;

const OVERFLOW_BASE = 47000;
const OVERFLOW_STEP = 7000;

export const computeLevel = (totalXp: number): number => {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalXp >= LEVEL_THRESHOLDS[i]) return i + 1;
  }
  return 1;
};

export const xpForLevel = (level: number): number => {
  if (level <= LEVEL_THRESHOLDS.length) return LEVEL_THRESHOLDS[level - 1] ?? 0;
  return OVERFLOW_BASE + (level - LEVEL_THRESHOLDS.length) * OVERFLOW_STEP;
};

export const xpForNextLevel = (level: number): number => {
  return xpForLevel(level + 1);
};

// ── Streaks ────────────────────────────────────────────────

export const STREAK_FREEZE_WEEKLY_GRANT = 1;
export const STREAK_FREEZE_MAX = 3;

// ── XP Sources ─────────────────────────────────────────────

export const XP_SOURCES = [
  'lesson_complete',
  'quiz_score',
  'exercise_pass',
  'review_complete',
] as const;
export type XpSource = (typeof XP_SOURCES)[number];

// ── Achievement Definitions ────────────────────────────────

export const ACHIEVEMENT_CATEGORIES = ['milestone', 'streak', 'mastery', 'dedication'] as const;
export type AchievementCategory = (typeof ACHIEVEMENT_CATEGORIES)[number];

export interface AchievementDefinition {
  id: string;
  category: AchievementCategory;
  name: string;
  description: string;
  icon: string;
  trigger: 'lesson' | 'quiz' | 'streak' | 'level';
}

export const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = [
  // Milestones
  { id: 'first_lesson', category: 'milestone', name: 'First Steps', description: 'Complete your first lesson', icon: 'book-open', trigger: 'lesson' },
  { id: 'ten_lessons', category: 'milestone', name: 'Getting Serious', description: 'Complete 10 lessons', icon: 'books', trigger: 'lesson' },
  { id: 'fifty_lessons', category: 'milestone', name: 'Knowledge Seeker', description: 'Complete 50 lessons', icon: 'graduation-cap', trigger: 'lesson' },
  { id: 'first_course', category: 'milestone', name: 'Course Complete', description: 'Complete an entire course', icon: 'trophy', trigger: 'lesson' },
  { id: 'three_courses', category: 'milestone', name: 'Lifelong Learner', description: 'Complete 3 courses', icon: 'star', trigger: 'lesson' },

  // Streaks
  { id: 'streak_3', category: 'streak', name: 'Getting Started', description: '3-day learning streak', icon: 'flame', trigger: 'streak' },
  { id: 'streak_7', category: 'streak', name: 'One Week Strong', description: '7-day learning streak', icon: 'flame', trigger: 'streak' },
  { id: 'streak_30', category: 'streak', name: 'Monthly Dedication', description: '30-day learning streak', icon: 'flame', trigger: 'streak' },

  // Mastery
  { id: 'perfect_quiz', category: 'mastery', name: 'Perfect Score', description: 'Score 100% on a module quiz', icon: 'target', trigger: 'quiz' },
  { id: 'all_mastered_course', category: 'mastery', name: 'Total Mastery', description: 'Master all modules in a course', icon: 'crown', trigger: 'quiz' },
  { id: 'first_review', category: 'mastery', name: 'Spaced Learner', description: 'Complete your first spaced review', icon: 'refresh-cw', trigger: 'quiz' },

  // Dedication
  { id: 'hour_learned', category: 'dedication', name: 'Hour of Learning', description: 'Spend 1 hour learning', icon: 'clock', trigger: 'lesson' },
  { id: 'ten_hours', category: 'dedication', name: 'Dedicated Learner', description: 'Spend 10 hours learning', icon: 'clock', trigger: 'lesson' },
  { id: 'level_5', category: 'dedication', name: 'Level 5', description: 'Reach level 5', icon: 'zap', trigger: 'level' },
  { id: 'level_10', category: 'dedication', name: 'Level 10', description: 'Reach level 10', icon: 'zap', trigger: 'level' },
];
