/**
 * NOTE — split lines for the next maintainer.
 *
 * This file is ~860 LOC and mixes five concerns: XP/leveling, badges
 * (achievements), streaks, leaderboards, and profile reads. The next
 * change here should extract along this seam:
 *
 *   - `gamificationCoreService.ts` — XP, levels, badges, streaks
 *     (everything that MUTATES UserGamification on user actions).
 *   - `gamificationProfileService.ts` — profile reads + leaderboard
 *     queries (everything READ-ONLY for display).
 *
 * Keep XP / badge / streak shared types here or move to
 * `lib/gamificationConstants.ts`. The two services don't currently
 * share state beyond the model itself, so the split is mechanical —
 * no cyclic-import hazard.
 *
 * Don't split unless you're already touching the file for an unrelated
 * reason. Breaking up a stable file just for size is churn for no
 * value; the marker exists to make the seam obvious when the next
 * feature lands.
 */
import mongoose from 'mongoose';
import UserGamificationModel, { IUserGamification } from '@models/UserGamificationModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import UserInsightProgressModel from '@models/UserInsightProgressModel';
import CourseModel from '@models/CourseModel';
import {
  XP_VALUES,
  XpSource,
  computeLevel,
  xpForNextLevel,
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

const daysBetween = ({ a, b }: { a: string; b: string }): number => {
  const dateA = new Date(a + 'T00:00:00Z');
  const dateB = new Date(b + 'T00:00:00Z');
  return Math.round((dateB.getTime() - dateA.getTime()) / 86400000);
};

/** Count missed weekdays (Mon–Fri) strictly between two YYYY-MM-DD dates (exclusive on both ends). */
const missedWeekdays = ({ a, b }: { a: string; b: string }): number => {
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

/**
 * Compute the user's current streak from their activity history.
 * Weekends are "free" — missing a Sat/Sun never breaks the streak —
 * but missing any weekday (Mon–Fri) without activity does.
 */
export const computeLiveStreak = (profile: { activeDates: string[] }): number => {
  const today = todayStr();
  const sorted = [...new Set(profile.activeDates)].sort((a, b) => b.localeCompare(a));

  if (sorted.length === 0) return 0;

  // Streak is alive only if no missed weekdays between most recent activity and today.
  const mostRecent = sorted[0];
  if (mostRecent !== today && missedWeekdays({ a: mostRecent, b: today }) > 0) return 0;

  // Walk backwards; any missed weekday between consecutive entries ends the streak.
  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (missedWeekdays({ a: sorted[i], b: sorted[i - 1] }) === 0) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
};

/** If the live streak exceeds the stored value, persist it and check streak achievements. */
export const syncLiveStreak = async ({ userId, liveStreak }: { userId: string; liveStreak: number }): Promise<void> => {
  const doc = await UserGamificationModel.findOne({ userId: new mongoose.Types.ObjectId(userId) });
  if (!doc || liveStreak <= doc.currentStreak) return;

  doc.currentStreak = liveStreak;
  if (liveStreak > doc.longestStreak) doc.longestStreak = liveStreak;
  await doc.save();

  await checkAchievements({ userId, trigger: 'streak', context: { streak: liveStreak } });
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

export const awardXp = async ({ userId, amount, source }: { userId: string; amount: number; source: XpSource }): Promise<AwardXpResult> => {
  if (amount <= 0) return { xpAwarded: 0, totalXp: 0, level: 1, leveledUp: false, newAchievements: [] };

  const today = todayStr();
  const doc = await UserGamificationModel.findOneAndUpdate(
    { userId: new mongoose.Types.ObjectId(userId) },
    {
      $inc: { totalXp: amount },
      // Rolling window on xpLog. Every consumer (`getGamificationStats`
      // lines 553 & 602) filters entries to the last 90 days or to the
      // current / previous ISO week — nothing reads entries older than
      // that. Capping at 2000 entries keeps the document under Mongo's
      // 16 MB ceiling even for a power user with multiple XP awards per
      // day over several years, and spares every stats read from
      // deserializing a forever-growing array.
      $push: { xpLog: { $each: [{ date: today, xp: amount, source }], $slice: -2000 } },
      $setOnInsert: { userId: new mongoose.Types.ObjectId(userId) },
    },
    { upsert: true, returnDocument: 'after' },
  );

  // Recompute level.
  //
  // `$inc` and `returnDocument: 'after'` above already make the XP increment
  // atomic and give us the post-increment totalXp. The remaining race is on
  // the level WRITE: if two concurrent awards compute newLevel=4 and
  // newLevel=5 respectively, and the 4-write lands after the 5-write, the
  // DB regresses. The conditional `level: { $lt: newLevel }` filter on
  // updateOne prevents that — a higher saved level can never be clobbered
  // by a lower-level save that arrives late.
  const newLevel = computeLevel(doc!.totalXp);
  const leveledUp = newLevel > doc!.level;

  if (newLevel !== doc!.level) {
    await UserGamificationModel.updateOne(
      { _id: doc!._id, level: { $lt: newLevel } },
      { $set: { level: newLevel } },
    );
  }

  // Check level-based achievements
  const newAchievements = await checkAchievements({ userId, trigger: 'level', context: { level: newLevel } });

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
  newAchievements: AchievementDefinition[];
}

export const recordActivity = async (userId: string): Promise<RecordActivityResult> => {
  const today = todayStr();
  const userObjId = new mongoose.Types.ObjectId(userId);

  // Read only the three fields the streak calculation needs. The previous
  // implementation loaded the full gamification doc (activeDates, xpLog,
  // earnedAchievements, ~everything) on every lesson/quiz/insight activity
  // just to check if today's already recorded. For the common case
  // (lastActiveDate === today → short-circuit), that was a wasted round-trip
  // worth of deserialization.
  const current = await UserGamificationModel.findOne({ userId: userObjId })
    .select('lastActiveDate currentStreak longestStreak')
    .lean();

  if (!current) {
    // First-ever activity — create the profile (upsert), then recurse once
    // so the new row is picked up by the normal path. `getOrCreateProfile`
    // uses `$setOnInsert` + upsert, so this is race-safe under concurrent
    // first-time activities.
    await getOrCreateProfile(userId);
    return recordActivity(userId);
  }

  if (current.lastActiveDate === today) {
    // Already active today — no streak change, no write.
    return {
      currentStreak: current.currentStreak,
      longestStreak: current.longestStreak,
      newAchievements: [],
    };
  }

  // Compute the next state in JS, then commit it with a single atomic update.
  // `$addToSet` on activeDates replaces the old read-check-push pattern —
  // handles the concurrent-first-activity-of-day race without conflict.
  const nextStreak = current.lastActiveDate && missedWeekdays({ a: current.lastActiveDate, b: today }) === 0
    ? current.currentStreak + 1
    : 1;
  const nextLongest = Math.max(current.longestStreak, nextStreak);

  await UserGamificationModel.updateOne(
    { userId: userObjId },
    {
      $addToSet: { activeDates: today },
      $set: {
        lastActiveDate: today,
        currentStreak: nextStreak,
        longestStreak: nextLongest,
      },
    },
  );

  const newAchievements = await checkAchievements({ userId, trigger: 'streak', context: { streak: nextStreak } });

  return {
    currentStreak: nextStreak,
    longestStreak: nextLongest,
    newAchievements,
  };
};

// ── Check Achievements ─────────────────────────────────────

const checkAchievements = async ({
  userId,
  trigger,
  context,
}: {
  userId: string;
  trigger: AchievementDefinition['trigger'];
  context: Record<string, unknown>;
}): Promise<AchievementDefinition[]> => {
  const doc = await UserGamificationModel.findOne({ userId: new mongoose.Types.ObjectId(userId) });
  if (!doc) return [];

  const earnedIds = new Set(doc.earnedAchievements.map((a) => a.achievementId));
  const candidates = ACHIEVEMENT_DEFINITIONS.filter((a) => a.trigger === trigger && !earnedIds.has(a.id));
  if (candidates.length === 0) return [];

  const userObjId = new mongoose.Types.ObjectId(userId);
  const newlyEarned: AchievementDefinition[] = [];

  // ── Precompute shared aggregates ──────────────────────────
  //
  // The per-achievement switch below would otherwise fire the same query
  // up to three times when multiple lesson-count thresholds are all
  // candidates (first / ten / fifty), and loop N countDocuments per course
  // for the course-completion family. Compute each aggregate once up
  // front and stash it on `context` so the switch can read a plain number
  // instead of re-hitting Mongo. The aggregates are only materialized when
  // at least one achievement needs them, so a streak-only trigger is still
  // a single query.
  const candidateIds = new Set(candidates.map((c) => c.id));
  const needsLessonCount = ['lesson_first', 'lessons_ten', 'lessons_fifty'].some((id) => candidateIds.has(id));
  const needsCourseCompletion = ['course_first', 'courses_three', 'courses_five'].some((id) => candidateIds.has(id));
  const needsTotalTime = ['hours_one', 'hours_ten', 'hours_twentyfive'].some((id) => candidateIds.has(id));

  if (needsLessonCount) {
    context.__completedLessonCount = await UserLessonProgressModel.countDocuments({
      userId: userObjId,
      status: 'completed',
    });
  }
  if (needsCourseCompletion) {
    // Per-course completed-lesson counts in a single aggregation instead
    // of one countDocuments per course inside the handler loop.
    const courses = await CourseModel.find({ userId: userObjId, status: 'ready' })
      .select('structure')
      .lean();
    const courseIds = courses.map((c) => c._id);
    const perCourseAgg = courseIds.length
      ? await UserLessonProgressModel.aggregate([
          { $match: { userId: userObjId, courseId: { $in: courseIds }, status: 'completed' } },
          { $group: { _id: '$courseId', completed: { $sum: 1 } } },
        ])
      : [];
    const completedByCourse = new Map<string, number>(
      perCourseAgg.map((row) => [String(row._id), row.completed as number]),
    );
    let fullyCompleted = 0;
    for (const course of courses) {
      const total = course.structure?.modules?.reduce(
        (s, m) => s + (m.lessons?.length ?? 0),
        0,
      ) ?? 0;
      if (total === 0) continue;
      if ((completedByCourse.get(String(course._id)) ?? 0) >= total) fullyCompleted++;
    }
    context.__fullyCompletedCourses = fullyCompleted;
  }
  if (needsTotalTime) {
    const agg = await UserLessonProgressModel.aggregate([
      { $match: { userId: userObjId } },
      { $group: { _id: null, total: { $sum: '$timeSpentSeconds' } } },
    ]);
    context.__totalTimeSpentSeconds = (agg[0]?.total as number | undefined) ?? 0;
  }

  for (const achievement of candidates) {
    const earned = await isAchievementEarned({ achievement, userObjId, context });
    if (!earned) continue;

    // Atomic per-achievement insert with a "not yet earned" filter. This
    // replaces the prior `doc.earnedAchievements.push()` + `doc.save()` flow,
    // which had a race window between two concurrent `checkAchievements`
    // calls for the same user — both would load the doc, both push the same
    // achievement, the second save would clobber the first or persist a
    // duplicate row in the array. The `$ne` filter here guarantees at most
    // one writer wins per (user, achievementId).
    const result = await UserGamificationModel.updateOne(
      {
        userId: userObjId,
        'earnedAchievements.achievementId': { $ne: achievement.id },
      },
      {
        $push: {
          earnedAchievements: {
            achievementId: achievement.id,
            earnedAt: new Date(),
            metadata: context as Record<string, unknown>,
          },
        },
      },
    );

    // modifiedCount === 1 → we won the race; modifiedCount === 0 → another
    // concurrent caller already inserted this achievement. Both outcomes
    // are correct; we only emit `newlyEarned` for the one we actually wrote.
    if (result.modifiedCount === 1) {
      newlyEarned.push(achievement);
    }
  }

  return newlyEarned;
};

const isAchievementEarned = async ({
  achievement,
  userObjId,
  context,
}: {
  achievement: AchievementDefinition;
  userObjId: mongoose.Types.ObjectId;
  context: Record<string, unknown>;
}): Promise<boolean> => {
  // Lesson-count and course-completion values were precomputed once by
  // `checkAchievements` and stashed on `context` under `__`-prefixed keys.
  // The handlers below just read them — no fall-back queries here, because
  // if the precompute was skipped we wouldn't be in that achievement's
  // handler in the first place (the `needs*` guards upstream ensure the
  // value is populated whenever a candidate needs it).
  const completedLessonCount = (context.__completedLessonCount as number | undefined) ?? 0;
  const fullyCompletedCourses = (context.__fullyCompletedCourses as number | undefined) ?? 0;
  const totalTimeSpentSeconds = (context.__totalTimeSpentSeconds as number | undefined) ?? 0;

  switch (achievement.id) {
    // Lesson milestones (single aggregate read from context)
    case 'lesson_first':
      return completedLessonCount >= 1;
    case 'lessons_ten':
      return completedLessonCount >= 10;
    case 'lessons_fifty':
      return completedLessonCount >= 50;

    // Course completion milestones (single aggregate read from context)
    case 'course_first':
      return fullyCompletedCourses >= 1;
    case 'courses_three':
      return fullyCompletedCourses >= 3;
    case 'courses_five':
      return fullyCompletedCourses >= 5;

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

    // Insight achievements (trigger: 'insight'). Cheap count-based
    // checks first; the cross-course-day query is an aggregation and
    // only runs while the user hasn't earned it (earnedIds guard
    // short-circuits in checkAchievements).
    case 'insight_first': {
      const count = await UserInsightProgressModel.countDocuments({ userId: userObjId });
      return count >= 1;
    }
    case 'insight_mastered_first': {
      const count = await UserInsightProgressModel.countDocuments({
        userId: userObjId,
        masteredAt: { $ne: null },
      });
      return count >= 1;
    }
    case 'insight_cross_course_day': {
      // "3+ distinct courses reviewed today (UTC)."
      const startOfDay = new Date(todayStr() + 'T00:00:00Z');
      const agg = await UserInsightProgressModel.aggregate([
        // Pre-filter progress rows to those with ANY event today. Eliminates
        // docs whose whole history pre-dates today before the $unwind expands
        // every event. Without this, a user with long histories pays for
        // unwinding every event on every rating until this achievement is earned.
        { $match: { userId: userObjId, 'history.ratedAt': { $gte: startOfDay } } },
        { $unwind: '$history' },
        { $match: { 'history.ratedAt': { $gte: startOfDay } } },
        // Collection name for Insight model is 'Insight' (3rd arg passed
        // explicitly in InsightModel.ts). Not Mongoose's default 'insights'.
        { $lookup: { from: 'Insight', localField: 'insightId', foreignField: '_id', as: 'insight' } },
        { $unwind: '$insight' },
        { $group: { _id: '$insight.courseId' } },
        { $count: 'distinctCourses' },
      ]);
      return ((agg[0]?.distinctCourses as number | undefined) ?? 0) >= 3;
    }

    // Dedication achievements (single aggregate read from context)
    case 'hours_one':
      return totalTimeSpentSeconds >= 3600;
    case 'hours_ten':
      return totalTimeSpentSeconds >= 36000;
    case 'hours_twentyfive':
      return totalTimeSpentSeconds >= 90000;

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

export const onLessonComplete = async ({ userId, courseId }: { userId: string; courseId: string }): Promise<OnLessonCompleteResult> => {
  // Award XP
  const xp = await awardXp({ userId, amount: XP_VALUES.LESSON_COMPLETE, source: 'lesson_complete' });

  // Update streak
  const streak = await recordActivity(userId);

  // Check lesson-count + time achievements
  const lessonAchievements = await checkAchievements({ userId, trigger: 'lesson', context: { courseId } });
  xp.newAchievements.push(...lessonAchievements);
  streak.newAchievements.push(...lessonAchievements.filter((a) => !xp.newAchievements.includes(a)));

  return { xp, streak };
};

// ── On Quiz Complete (orchestrator) ────────────────────────

export interface OnQuizCompleteResult {
  xp: AwardXpResult;
  newAchievements: AchievementDefinition[];
}

export const onQuizComplete = async ({
  userId,
  courseId,
  score,
  previousBestScore,
  isReview,
}: {
  userId: string;
  courseId: string;
  score: number;
  previousBestScore: number;
  isReview: boolean;
}): Promise<OnQuizCompleteResult> => {
  // Award XP for score improvement only
  const scoreDelta = Math.max(0, score - previousBestScore);
  const scoreXp = Math.round(scoreDelta * XP_VALUES.QUIZ_SCORE_MULTIPLIER);
  const reviewXp = isReview ? XP_VALUES.REVIEW_COMPLETE : 0;
  const totalXp = scoreXp + reviewXp;

  let xp: AwardXpResult = { xpAwarded: 0, totalXp: 0, level: 1, leveledUp: false, newAchievements: [] };

  if (scoreXp > 0) {
    xp = await awardXp({ userId, amount: scoreXp, source: 'quiz_score' });
  }
  if (reviewXp > 0) {
    const reviewResult = await awardXp({ userId, amount: reviewXp, source: 'review_complete' });
    xp.xpAwarded += reviewResult.xpAwarded;
    xp.totalXp = reviewResult.totalXp;
    xp.level = reviewResult.level;
    if (reviewResult.leveledUp) xp.leveledUp = true;
    xp.newAchievements.push(...reviewResult.newAchievements);
  }

  // Record streak activity (quiz submission is meaningful learning)
  await recordActivity(userId);

  // Check quiz achievements
  const quizAchievements = await checkAchievements({ userId, trigger: 'quiz', context: { score, courseId, isReview } });
  xp.newAchievements.push(...quizAchievements);

  return { xp, newAchievements: quizAchievements };
};

// ── On Exercise Pass ───────────────────────────────────────

export const onExercisePass = async (userId: string): Promise<AwardXpResult> => {
  return awardXp({ userId, amount: XP_VALUES.EXERCISE_PASS, source: 'exercise_pass' });
};

// ── On Insight Review (orchestrator) ───────────────────────

export interface OnInsightReviewResult {
  xp: AwardXpResult;
  streak: RecordActivityResult;
  newAchievements: AchievementDefinition[];
}

/**
 * Fire XP + streak credit + insight-achievement check for a graded review.
 * Streak updates happen via recordActivity which is idempotent per-day.
 * Achievement check uses the `earnedIds` guard, so expensive queries
 * (cross-course) short-circuit once the user has earned the achievement.
 */
export const onInsightReview = async ({
  userId,
  insightId,
  courseId,
}: {
  userId: string;
  insightId: string;
  courseId: string;
}): Promise<OnInsightReviewResult> => {
  const xp = await awardXp({ userId, amount: XP_VALUES.INSIGHT_REVIEW, source: 'insight_review' });
  const streak = await recordActivity(userId);
  const ach = await checkAchievements({ userId, trigger: 'insight', context: { insightId, courseId, mastered: false } });
  xp.newAchievements.push(...ach);
  return { xp, streak, newAchievements: ach };
};

// ── On Insight Mastered (orchestrator) ─────────────────────

export interface OnInsightMasteredResult {
  xp: AwardXpResult;
  streak: RecordActivityResult;
  newAchievements: AchievementDefinition[];
}

/**
 * Fire the one-time mastery reward when an insight first reaches
 * Leitner box 4. Idempotency is guaranteed upstream in the scheduler
 * (`justMastered` is true exactly once per insight).
 */
export const onInsightMastered = async ({
  userId,
  insightId,
  courseId,
}: {
  userId: string;
  insightId: string;
  courseId: string;
}): Promise<OnInsightMasteredResult> => {
  const xp = await awardXp({ userId, amount: XP_VALUES.INSIGHT_MASTERY, source: 'insight_mastery' });
  const streak = await recordActivity(userId);
  const ach = await checkAchievements({ userId, trigger: 'insight', context: { insightId, courseId, mastered: true } });
  xp.newAchievements.push(...ach);
  return { xp, streak, newAchievements: ach };
};

// ── Get Gamification Stats ─────────────────────────────────

interface XpByDayEntry {
  date: string;
  xp: number;
  sources: {
    lesson_complete: number;
    quiz_score: number;
    exercise_pass: number;
    review_complete: number;
    insight_review: number;
    insight_mastery: number;
  };
}

interface WeeklySummaryPeriod {
  xp: number;
  timeSeconds: number;
  lessons: number;
  quizzes: number;
  insights: number;
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

  const emptySources = () => ({ lesson_complete: 0, quiz_score: 0, exercise_pass: 0, review_complete: 0, insight_review: 0, insight_mastery: 0 });
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
    const xp =
      sources.lesson_complete +
      sources.quiz_score +
      sources.exercise_pass +
      sources.review_complete +
      sources.insight_review +
      sources.insight_mastery;
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

  // Time, lessons, quizzes, insights — parallel queries.
  // Insight counts: one aggregation with conditional $sum for both weeks,
  // pre-filtered to docs that have any event in the last ~14 days. Without
  // the pre-match, MongoDB would unwind every history event the user has
  // ever accumulated — on every Profile stats load.
  const insightReviewCountsP = UserInsightProgressModel.aggregate<{
    _id: null;
    thisWeek: number;
    lastWeek: number;
  }>([
    { $match: { userId: userObjId, 'history.ratedAt': { $gte: startOfLastWeek } } },
    { $unwind: '$history' },
    // Second filter bounds the unwound events. The $match above is doc-level:
    // a doc whose array contains both an old and a recent event passes, so
    // old events reach this stage and need trimming.
    { $match: { 'history.ratedAt': { $gte: startOfLastWeek } } },
    {
      $group: {
        _id: null,
        thisWeek: { $sum: { $cond: [{ $gte: ['$history.ratedAt', startOfWeek] }, 1, 0] } },
        lastWeek: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gte: ['$history.ratedAt', startOfLastWeek] },
                  { $lt: ['$history.ratedAt', startOfWeek] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  const [
    thisWeekTime, lastWeekTime,
    lessonsThisWeek, lessonsLastWeek,
    quizzesThisWeek, quizzesLastWeek,
    insightReviewCounts,
  ] = await Promise.all([
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
    insightReviewCountsP,
  ]);

  const insightsThisWeek = insightReviewCounts[0]?.thisWeek ?? 0;
  const insightsLastWeek = insightReviewCounts[0]?.lastWeek ?? 0;

  const weeklySummary = {
    thisWeek: {
      xp: thisWeekXp, timeSeconds: thisWeekTime, lessons: lessonsThisWeek,
      quizzes: quizzesThisWeek, insights: insightsThisWeek,
    },
    lastWeek: {
      xp: lastWeekXp, timeSeconds: lastWeekTime, lessons: lessonsLastWeek,
      quizzes: quizzesLastWeek, insights: insightsLastWeek,
    },
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

