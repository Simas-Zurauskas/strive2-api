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

/** Count missed weekdays (Mon–Fri) strictly between two YYYY-MM-DD dates (exclusive on both ends). */
const missedWeekdays = (a: string, b: string): number => {
  const start = new Date(a + 'T00:00:00Z');
  const end = new Date(b + 'T00:00:00Z');
  let count = 0;
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d < end) {
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
};

// ── Live Streak (read-time adjustment) ────────────────────

export const computeLiveStreak = (profile: {
  activeDates: string[];
  streakFreezeAvailable: number;
  streakFreezeUsedDates: string[];
}): number => {
  const today = todayStr();
  const sorted = [...new Set(profile.activeDates)].sort((a, b) => b.localeCompare(a));

  if (sorted.length === 0) return 0;

  // Check if streak is alive: no missed weekdays between most recent activity and today
  const mostRecent = sorted[0];
  if (mostRecent !== today) {
    const missed = missedWeekdays(mostRecent, today);
    if (missed > 1) return 0;
    if (missed === 1 && profile.streakFreezeAvailable <= 0) return 0;
  }

  // Recompute streak from activeDates going backwards
  const freezeSet = new Set(profile.streakFreezeUsedDates);
  let streak = 1;

  for (let i = 1; i < sorted.length; i++) {
    const missed = missedWeekdays(sorted[i], sorted[i - 1]);
    if (missed === 0) {
      streak++;
    } else if (missed === 1) {
      // Check if the missed weekday was covered by a freeze
      const d = new Date(sorted[i] + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
      if (freezeSet.has(d.toISOString().slice(0, 10))) {
        streak++;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return streak;
};

/** If the live streak exceeds the stored value, persist it and check streak achievements. */
export const syncLiveStreak = async (userId: string, liveStreak: number): Promise<void> => {
  const doc = await UserGamificationModel.findOne({ userId: new mongoose.Types.ObjectId(userId) });
  if (!doc || liveStreak <= doc.currentStreak) return;

  doc.currentStreak = liveStreak;
  if (liveStreak > doc.longestStreak) doc.longestStreak = liveStreak;
  await doc.save();

  await checkAchievements(userId, 'streak', { streak: liveStreak });
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

export const awardXp = async (userId: string, amount: number, source: XpSource): Promise<AwardXpResult> => {
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
    const missed = missedWeekdays(doc.lastActiveDate, today);

    if (missed === 0) {
      // Consecutive (or only weekends between)
      doc.currentStreak += 1;
    } else if (missed === 1 && doc.streakFreezeAvailable > 0) {
      // Missed exactly 1 weekday — auto-apply freeze
      doc.streakFreezeAvailable -= 1;
      // Find the actual missed weekday
      const d = new Date(doc.lastActiveDate + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
        d.setUTCDate(d.getUTCDate() + 1);
      }
      doc.streakFreezeUsedDates.push(d.toISOString().slice(0, 10));
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
    case 'lesson_first': {
      const count = await UserLessonProgressModel.countDocuments({ userId: userObjId, status: 'completed' });
      return count >= 1;
    }
    case 'lessons_ten': {
      const count = await UserLessonProgressModel.countDocuments({ userId: userObjId, status: 'completed' });
      return count >= 10;
    }
    case 'lessons_fifty': {
      const count = await UserLessonProgressModel.countDocuments({ userId: userObjId, status: 'completed' });
      return count >= 50;
    }

    // Course completion milestones
    case 'course_first':
    case 'courses_three':
    case 'courses_five': {
      const threshold = achievement.id === 'course_first' ? 1 : achievement.id === 'courses_three' ? 3 : 5;
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
    case 'streak_3':
      return (context.streak as number) >= 3;
    case 'streak_7':
      return (context.streak as number) >= 7;
    case 'streak_14':
      return (context.streak as number) >= 14;

    // Quiz/mastery achievements
    case 'quiz_perfect':
      return (context.score as number) === 100;
    case 'review_first':
      return (context.isReview as boolean) === true;
    case 'course_mastered': {
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
    case 'hours_one':
    case 'hours_ten':
    case 'hours_twentyfive': {
      const threshold = achievement.id === 'hours_one' ? 3600 : achievement.id === 'hours_ten' ? 36000 : 90000;
      const agg = await UserLessonProgressModel.aggregate([
        { $match: { userId: userObjId } },
        { $group: { _id: null, total: { $sum: '$timeSpentSeconds' } } },
      ]);
      return (agg[0]?.total ?? 0) >= threshold;
    }

    // Level achievements
    case 'level_5':
      return (context.level as number) >= 5;
    case 'level_15':
      return (context.level as number) >= 15;
    case 'level_25':
      return (context.level as number) >= 25;

    default:
      return false;
  }
};

// ── On Lesson Complete (orchestrator) ──────────────────────

export interface OnLessonCompleteResult {
  xp: AwardXpResult;
  streak: RecordActivityResult;
}

export const onLessonComplete = async (userId: string, courseId: string): Promise<OnLessonCompleteResult> => {
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

interface XpByDayEntry {
  date: string;
  xp: number;
  sources: { lesson_complete: number; quiz_score: number; exercise_pass: number; review_complete: number };
}

interface WeeklySummaryPeriod {
  xp: number;
  timeSeconds: number;
  lessons: number;
  quizzes: number;
}

export interface GamificationStats {
  xpByDay: XpByDayEntry[];
  xpByWeek: { week: string; xp: number }[];
  totalTimeLearned: number;
  lessonsThisWeek: number;
  weeklySummary: { thisWeek: WeeklySummaryPeriod; lastWeek: WeeklySummaryPeriod };
}

export const getGamificationStats = async (userId: string): Promise<GamificationStats> => {
  const userObjId = new mongoose.Types.ObjectId(userId);
  const profile = await getOrCreateProfile(userId);

  const now = new Date();
  const today = todayStr();

  // ── Week boundaries ──────────────────────────────
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);

  const startOfLastWeek = new Date(startOfWeek);
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

  const startOfWeekStr = startOfWeek.toISOString().slice(0, 10);
  const startOfLastWeekStr = startOfLastWeek.toISOString().slice(0, 10);

  // ── Dense XP by day (90 days, with source breakdown) ─────
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 89); // 89 + today = 90 days
  const ninetyDaysAgoStr = ninetyDaysAgo.toISOString().slice(0, 10);

  const emptySources = () => ({ lesson_complete: 0, quiz_score: 0, exercise_pass: 0, review_complete: 0 });
  const xpByDayMap = new Map<string, ReturnType<typeof emptySources>>();

  for (const entry of profile.xpLog) {
    if (entry.date >= ninetyDaysAgoStr) {
      if (!xpByDayMap.has(entry.date)) xpByDayMap.set(entry.date, emptySources());
      const sources = xpByDayMap.get(entry.date)!;
      const key = entry.source as keyof ReturnType<typeof emptySources>;
      if (key in sources) sources[key] += entry.xp;
    }
  }

  // Fill all 90 days (dense)
  const xpByDay: XpByDayEntry[] = [];
  const cursor = new Date(ninetyDaysAgo);
  while (cursor <= now) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const sources = xpByDayMap.get(dateStr) ?? emptySources();
    const xp = sources.lesson_complete + sources.quiz_score + sources.exercise_pass + sources.review_complete;
    xpByDay.push({ date: dateStr, xp, sources });
    cursor.setDate(cursor.getDate() + 1);
  }

  // ── XP by week (from 90-day window) ──────────────
  const xpByWeekMap = new Map<string, number>();
  for (const day of xpByDay) {
    if (day.xp > 0) {
      const week = getISOWeek(new Date(day.date + 'T00:00:00Z'));
      xpByWeekMap.set(week, (xpByWeekMap.get(week) ?? 0) + day.xp);
    }
  }
  const xpByWeek = [...xpByWeekMap.entries()]
    .map(([week, xp]) => ({ week, xp }))
    .sort((a, b) => a.week.localeCompare(b.week));

  // ── Total time learned ───────────────────────────
  const timeAgg = await UserLessonProgressModel.aggregate([
    { $match: { userId: userObjId } },
    { $group: { _id: null, total: { $sum: '$timeSpentSeconds' } } },
  ]);
  const totalTimeLearned = timeAgg[0]?.total ?? 0;

  // ── Weekly summary (this week vs last week) ──────
  // XP from xpLog
  let thisWeekXp = 0;
  let lastWeekXp = 0;
  for (const entry of profile.xpLog) {
    if (entry.date >= startOfWeekStr) {
      thisWeekXp += entry.xp;
    } else if (entry.date >= startOfLastWeekStr && entry.date < startOfWeekStr) {
      lastWeekXp += entry.xp;
    }
  }

  // Time, lessons, quizzes — parallel queries
  const [thisWeekTime, lastWeekTime, lessonsThisWeek, lessonsLastWeek, quizzesThisWeek, quizzesLastWeek] =
    await Promise.all([
      UserLessonProgressModel.aggregate([
        { $match: { userId: userObjId, lastAccessedAt: { $gte: startOfWeek } } },
        { $group: { _id: null, total: { $sum: '$timeSpentSeconds' } } },
      ]).then((r) => r[0]?.total ?? 0),
      UserLessonProgressModel.aggregate([
        { $match: { userId: userObjId, lastAccessedAt: { $gte: startOfLastWeek, $lt: startOfWeek } } },
        { $group: { _id: null, total: { $sum: '$timeSpentSeconds' } } },
      ]).then((r) => r[0]?.total ?? 0),
      UserLessonProgressModel.countDocuments({
        userId: userObjId,
        status: 'completed',
        completedAt: { $gte: startOfWeek },
      }),
      UserLessonProgressModel.countDocuments({
        userId: userObjId,
        status: 'completed',
        completedAt: { $gte: startOfLastWeek, $lt: startOfWeek },
      }),
      UserModuleQuizProgressModel.countDocuments({
        userId: userObjId,
        'attempts.completedAt': { $gte: startOfWeek },
      }),
      UserModuleQuizProgressModel.countDocuments({
        userId: userObjId,
        'attempts.completedAt': { $gte: startOfLastWeek, $lt: startOfWeek },
      }),
    ]);

  const weeklySummary = {
    thisWeek: { xp: thisWeekXp, timeSeconds: thisWeekTime, lessons: lessonsThisWeek, quizzes: quizzesThisWeek },
    lastWeek: { xp: lastWeekXp, timeSeconds: lastWeekTime, lessons: lessonsLastWeek, quizzes: quizzesLastWeek },
  };

  return { xpByDay, xpByWeek, totalTimeLearned, lessonsThisWeek, weeklySummary };
};

// ── Quiz Trends ───────────────────────────────────────────

export interface QuizTrendsResult {
  attempts: {
    date: string;
    score: number;
    courseId: string;
    courseName: string;
    moduleName: string;
    moduleIndex: number;
  }[];
  averageScore: number;
  recentTrend: number;
}

export const getQuizTrends = async (userId: string): Promise<QuizTrendsResult> => {
  const userObjId = new mongoose.Types.ObjectId(userId);

  const progressDocs = await UserModuleQuizProgressModel.find({ userId: userObjId }).lean();
  if (progressDocs.length === 0) return { attempts: [], averageScore: 0, recentTrend: 0 };

  // Gather all courseIds and fetch course names + module names
  const courseIds = [...new Set(progressDocs.map((d) => d.courseId.toString()))];
  const courses = await CourseModel.find({ _id: { $in: courseIds } })
    .select('name structure')
    .lean();
  const courseMap = new Map(courses.map((c) => [c._id.toString(), c]));

  // Flatten all attempts
  const attempts: QuizTrendsResult['attempts'] = [];
  for (const doc of progressDocs) {
    const course = courseMap.get(doc.courseId.toString());
    if (!course) continue;
    const moduleName = course.structure?.modules?.[doc.moduleIndex]?.name ?? `Module ${doc.moduleIndex + 1}`;

    for (const attempt of doc.attempts) {
      attempts.push({
        date: attempt.completedAt.toISOString().slice(0, 10),
        score: attempt.score,
        courseId: doc.courseId.toString(),
        courseName: course.name,
        moduleName,
        moduleIndex: doc.moduleIndex,
      });
    }
  }

  attempts.sort((a, b) => a.date.localeCompare(b.date));

  if (attempts.length === 0) return { attempts: [], averageScore: 0, recentTrend: 0 };

  const averageScore = Math.round(attempts.reduce((s, a) => s + a.score, 0) / attempts.length);

  // Recent trend: average of last 30 days vs previous 30 days
  const today = todayStr();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const thirtyStr = thirtyDaysAgo.toISOString().slice(0, 10);
  const sixtyStr = sixtyDaysAgo.toISOString().slice(0, 10);

  const recent = attempts.filter((a) => a.date >= thirtyStr && a.date <= today);
  const prior = attempts.filter((a) => a.date >= sixtyStr && a.date < thirtyStr);

  const recentAvg = recent.length > 0 ? recent.reduce((s, a) => s + a.score, 0) / recent.length : 0;
  const priorAvg = prior.length > 0 ? prior.reduce((s, a) => s + a.score, 0) / prior.length : 0;
  const recentTrend = prior.length > 0 ? Math.round(recentAvg - priorAvg) : 0;

  return { attempts, averageScore, recentTrend };
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
