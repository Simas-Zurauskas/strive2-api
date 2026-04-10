import mongoose from 'mongoose';
import UserGamificationModel, { IUserGamification } from '@models/UserGamificationModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import CourseModel from '@models/CourseModel';
import {
  XP_VALUES,
  XpSource,
  computeLevel,
  xpForNextLevel,
  STREAK_FREEZE_WEEKLY_GRANT,
  STREAK_FREEZE_MAX,
  ACHIEVEMENT_DEFINITIONS,
  AchievementDefinition,
} from '@lib/gamificationConstants';

// ── Helpers ────────────────────────────────────────────────

const todayStr = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const getISOWeek = (date: Date): string => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

const daysBetween = (a: string, b: string): number => {
  const dateA = new Date(a + 'T00:00:00Z');
  const dateB = new Date(b + 'T00:00:00Z');
  return Math.round((dateB.getTime() - dateA.getTime()) / 86400000);
};

// ── Get or Create Profile ──────────────────────────────────

export const getOrCreateProfile = async (userId: string): Promise<IUserGamification> => {
  const doc = await UserGamificationModel.findOneAndUpdate(
    { userId: new mongoose.Types.ObjectId(userId) },
    { $setOnInsert: { userId: new mongoose.Types.ObjectId(userId) } },
    { upsert: true, returnDocument: 'after' },
  );
  return doc!.toJSON();
};

// ── Award XP ───────────────────────────────────────────────

export interface AwardXpResult {
  xpAwarded: number;
  totalXp: number;
  level: number;
  leveledUp: boolean;
  newAchievements: AchievementDefinition[];
}

export const awardXp = async (
  userId: string,
  amount: number,
  source: XpSource,
): Promise<AwardXpResult> => {
  if (amount <= 0) return { xpAwarded: 0, totalXp: 0, level: 1, leveledUp: false, newAchievements: [] };

  const today = todayStr();
  const doc = await UserGamificationModel.findOneAndUpdate(
    { userId: new mongoose.Types.ObjectId(userId) },
    {
      $inc: { totalXp: amount },
      $push: { xpLog: { date: today, xp: amount, source } },
      $setOnInsert: { userId: new mongoose.Types.ObjectId(userId) },
    },
    { upsert: true, returnDocument: 'after' },
  );

  // Recompute level
  const newLevel = computeLevel(doc!.totalXp);
  const leveledUp = newLevel > doc!.level;

  if (newLevel !== doc!.level) {
    doc!.level = newLevel;
    await doc!.save();
  }

  // Check level-based achievements
  const newAchievements = await checkAchievements(userId, 'level', { level: newLevel });

  return {
    xpAwarded: amount,
    totalXp: doc!.totalXp,
    level: newLevel,
    leveledUp,
    newAchievements,
  };
};

// ── Record Activity (Streak) ───────────────────────────────

export interface RecordActivityResult {
  currentStreak: number;
  longestStreak: number;
  streakFreezeUsed: boolean;
  newAchievements: AchievementDefinition[];
}

export const recordActivity = async (userId: string): Promise<RecordActivityResult> => {
  const today = todayStr();
  const currentWeek = getISOWeek(new Date());

  const doc = await UserGamificationModel.findOne({ userId: new mongoose.Types.ObjectId(userId) });
  if (!doc) {
    await getOrCreateProfile(userId);
    return recordActivity(userId);
  }

  // Grant weekly streak freeze
  if (doc.streakFreezeLastGrantedWeek !== currentWeek) {
    doc.streakFreezeAvailable = Math.min(doc.streakFreezeAvailable + STREAK_FREEZE_WEEKLY_GRANT, STREAK_FREEZE_MAX);
    doc.streakFreezeLastGrantedWeek = currentWeek;
  }

  let streakFreezeUsed = false;

  if (doc.lastActiveDate === today) {
    // Already active today — no streak change
    return {
      currentStreak: doc.currentStreak,
      longestStreak: doc.longestStreak,
      streakFreezeUsed: false,
      newAchievements: [],
    };
  }

  // Track this date as active
  doc.activeDates.push(today);

  if (doc.lastActiveDate) {
    const gap = daysBetween(doc.lastActiveDate, today);

    if (gap === 1) {
      // Consecutive day
      doc.currentStreak += 1;
    } else if (gap === 2 && doc.streakFreezeAvailable > 0) {
      // Missed exactly 1 day — auto-apply freeze
      doc.streakFreezeAvailable -= 1;
      doc.streakFreezeUsedDates.push(doc.lastActiveDate.replace(/^(\d{4}-\d{2}-)(\d{2})$/, (_m, prefix, day) => {
        return prefix + String(Number(day) + 1).padStart(2, '0');
      }));
      doc.currentStreak += 1;
      streakFreezeUsed = true;
    } else {
      // Streak broken
      doc.currentStreak = 1;
    }
  } else {
    // First ever activity
    doc.currentStreak = 1;
  }

  doc.lastActiveDate = today;
  if (doc.currentStreak > doc.longestStreak) {
    doc.longestStreak = doc.currentStreak;
  }

  await doc.save();

  // Check streak achievements
  const newAchievements = await checkAchievements(userId, 'streak', { streak: doc.currentStreak });

  return {
    currentStreak: doc.currentStreak,
    longestStreak: doc.longestStreak,
    streakFreezeUsed,
    newAchievements,
  };
};

// ── Check Achievements ─────────────────────────────────────

const checkAchievements = async (
  userId: string,
  trigger: AchievementDefinition['trigger'],
  context: Record<string, unknown>,
): Promise<AchievementDefinition[]> => {
  const doc = await UserGamificationModel.findOne({ userId: new mongoose.Types.ObjectId(userId) });
  if (!doc) return [];

  const earnedIds = new Set(doc.earnedAchievements.map((a) => a.achievementId));
  const candidates = ACHIEVEMENT_DEFINITIONS.filter((a) => a.trigger === trigger && !earnedIds.has(a.id));
  if (candidates.length === 0) return [];

  const userObjId = new mongoose.Types.ObjectId(userId);
  const newlyEarned: AchievementDefinition[] = [];

  for (const achievement of candidates) {
    const earned = await isAchievementEarned(achievement, userObjId, context);
    if (earned) {
      doc.earnedAchievements.push({
        achievementId: achievement.id,
        earnedAt: new Date(),
        metadata: context as Record<string, unknown>,
      });
      newlyEarned.push(achievement);
    }
  }

  if (newlyEarned.length > 0) {
    await doc.save();
  }

  return newlyEarned;
};

const isAchievementEarned = async (
  achievement: AchievementDefinition,
  userObjId: mongoose.Types.ObjectId,
  context: Record<string, unknown>,
): Promise<boolean> => {
  switch (achievement.id) {
    // Lesson milestones
    case 'first_lesson': {
      const count = await UserLessonProgressModel.countDocuments({ userId: userObjId, status: 'completed' });
      return count >= 1;
    }
    case 'ten_lessons': {
      const count = await UserLessonProgressModel.countDocuments({ userId: userObjId, status: 'completed' });
      return count >= 10;
    }
    case 'fifty_lessons': {
      const count = await UserLessonProgressModel.countDocuments({ userId: userObjId, status: 'completed' });
      return count >= 50;
    }

    // Course completion milestones
    case 'first_course':
    case 'three_courses': {
      const threshold = achievement.id === 'first_course' ? 1 : 3;
      const courses = await CourseModel.find({ userId: userObjId, status: 'ready' }).select('structure').lean();
      let completedCourses = 0;

      for (const course of courses) {
        const totalLessons = course.structure?.modules?.reduce((s, m) => s + (m.lessons?.length ?? 0), 0) ?? 0;
        if (totalLessons === 0) continue;
        const completedCount = await UserLessonProgressModel.countDocuments({
          userId: userObjId,
          courseId: course._id,
          status: 'completed',
        });
        if (completedCount >= totalLessons) completedCourses++;
      }
      return completedCourses >= threshold;
    }

    // Streak achievements
    case 'streak_3': return (context.streak as number) >= 3;
    case 'streak_7': return (context.streak as number) >= 7;
    case 'streak_30': return (context.streak as number) >= 30;

    // Quiz/mastery achievements
    case 'perfect_quiz': return (context.score as number) === 100;
    case 'first_review': return (context.isReview as boolean) === true;
    case 'all_mastered_course': {
      const courseId = context.courseId as string;
      if (!courseId) return false;
      const course = await CourseModel.findById(courseId).select('structure').lean();
      if (!course?.structure?.modules) return false;
      const totalModules = course.structure.modules.length;
      const masteredCount = await UserModuleQuizProgressModel.countDocuments({
        userId: userObjId,
        courseId,
        bestTier: 'mastered',
      });
      return masteredCount >= totalModules;
    }

    // Dedication achievements
    case 'hour_learned':
    case 'ten_hours': {
      const threshold = achievement.id === 'hour_learned' ? 3600 : 36000;
      const agg = await UserLessonProgressModel.aggregate([
        { $match: { userId: userObjId } },
        { $group: { _id: null, total: { $sum: '$timeSpentSeconds' } } },
      ]);
      return (agg[0]?.total ?? 0) >= threshold;
    }

    // Level achievements
    case 'level_5': return (context.level as number) >= 5;
    case 'level_10': return (context.level as number) >= 10;

    default: return false;
  }
};

// ── On Lesson Complete (orchestrator) ──────────────────────

export interface OnLessonCompleteResult {
  xp: AwardXpResult;
  streak: RecordActivityResult;
}

export const onLessonComplete = async (
  userId: string,
  courseId: string,
): Promise<OnLessonCompleteResult> => {
  // Award XP
  const xp = await awardXp(userId, XP_VALUES.LESSON_COMPLETE, 'lesson_complete');

  // Update streak
  const streak = await recordActivity(userId);

  // Check lesson-count + time achievements
  const lessonAchievements = await checkAchievements(userId, 'lesson', { courseId });
  xp.newAchievements.push(...lessonAchievements);
  streak.newAchievements.push(...lessonAchievements.filter((a) => !xp.newAchievements.includes(a)));

  return { xp, streak };
};

// ── On Quiz Complete (orchestrator) ────────────────────────

export interface OnQuizCompleteResult {
  xp: AwardXpResult;
  newAchievements: AchievementDefinition[];
}

export const onQuizComplete = async (
  userId: string,
  courseId: string,
  score: number,
  previousBestScore: number,
  isReview: boolean,
): Promise<OnQuizCompleteResult> => {
  // Award XP for score improvement only
  const scoreDelta = Math.max(0, score - previousBestScore);
  const scoreXp = Math.round(scoreDelta * XP_VALUES.QUIZ_SCORE_MULTIPLIER);
  const reviewXp = isReview ? XP_VALUES.REVIEW_COMPLETE : 0;
  const totalXp = scoreXp + reviewXp;

  let xp: AwardXpResult = { xpAwarded: 0, totalXp: 0, level: 1, leveledUp: false, newAchievements: [] };

  if (scoreXp > 0) {
    xp = await awardXp(userId, scoreXp, 'quiz_score');
  }
  if (reviewXp > 0) {
    const reviewResult = await awardXp(userId, reviewXp, 'review_complete');
    xp.xpAwarded += reviewResult.xpAwarded;
    xp.totalXp = reviewResult.totalXp;
    xp.level = reviewResult.level;
    if (reviewResult.leveledUp) xp.leveledUp = true;
    xp.newAchievements.push(...reviewResult.newAchievements);
  }

  // Record streak activity (quiz submission is meaningful learning)
  await recordActivity(userId);

  // Check quiz achievements
  const quizAchievements = await checkAchievements(userId, 'quiz', { score, courseId, isReview });
  xp.newAchievements.push(...quizAchievements);

  return { xp, newAchievements: quizAchievements };
};

// ── On Exercise Pass ───────────────────────────────────────

export const onExercisePass = async (userId: string): Promise<AwardXpResult> => {
  return awardXp(userId, XP_VALUES.EXERCISE_PASS, 'exercise_pass');
};

// ── Get Gamification Stats ─────────────────────────────────

export interface GamificationStats {
  xpByDay: { date: string; xp: number }[];
  xpByWeek: { week: string; xp: number }[];
  totalTimeLearned: number;
  lessonsThisWeek: number;
}

export const getGamificationStats = async (userId: string): Promise<GamificationStats> => {
  const userObjId = new mongoose.Types.ObjectId(userId);
  const profile = await getOrCreateProfile(userId);

  // XP by day (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

  const xpByDayMap = new Map<string, number>();
  for (const entry of profile.xpLog) {
    if (entry.date >= thirtyDaysAgoStr) {
      xpByDayMap.set(entry.date, (xpByDayMap.get(entry.date) ?? 0) + entry.xp);
    }
  }
  const xpByDay = [...xpByDayMap.entries()]
    .map(([date, xp]) => ({ date, xp }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // XP by week (last 8 weeks)
  const xpByWeekMap = new Map<string, number>();
  for (const entry of profile.xpLog) {
    if (entry.date >= thirtyDaysAgoStr) {
      const week = getISOWeek(new Date(entry.date + 'T00:00:00Z'));
      xpByWeekMap.set(week, (xpByWeekMap.get(week) ?? 0) + entry.xp);
    }
  }
  const xpByWeek = [...xpByWeekMap.entries()]
    .map(([week, xp]) => ({ week, xp }))
    .sort((a, b) => a.week.localeCompare(b.week));

  // Total time learned
  const timeAgg = await UserLessonProgressModel.aggregate([
    { $match: { userId: userObjId } },
    { $group: { _id: null, total: { $sum: '$timeSpentSeconds' } } },
  ]);
  const totalTimeLearned = timeAgg[0]?.total ?? 0;

  // Lessons completed this week
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const lessonsThisWeek = await UserLessonProgressModel.countDocuments({
    userId: userObjId,
    status: 'completed',
    completedAt: { $gte: startOfWeek },
  });

  return { xpByDay, xpByWeek, totalTimeLearned, lessonsThisWeek };
};

// ── Use Streak Freeze ──────────────────────────────────────

export const useStreakFreeze = async (userId: string): Promise<{ success: boolean; freezesRemaining: number }> => {
  const doc = await UserGamificationModel.findOne({ userId: new mongoose.Types.ObjectId(userId) });
  if (!doc || doc.streakFreezeAvailable <= 0) {
    return { success: false, freezesRemaining: doc?.streakFreezeAvailable ?? 0 };
  }

  const today = todayStr();
  doc.streakFreezeAvailable -= 1;
  doc.streakFreezeUsedDates.push(today);
  await doc.save();

  return { success: true, freezesRemaining: doc.streakFreezeAvailable };
};
