import mongoose, { Types } from 'mongoose';
import InsightModel, { IInsight } from '@models/InsightModel';
import UserInsightProgressModel, {
  IUserInsightProgress,
} from '@models/UserInsightProgressModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import CourseModel from '@models/CourseModel';
import {
  INSIGHT_QUEUE_DUE_LIMIT,
  INSIGHT_QUEUE_FRESH_LIMIT_DEFAULT,
  INSIGHT_QUEUE_FRESH_THRESHOLD,
  InsightMode,
} from '@lib/insightConstants';

// ── Types ──────────────────────────────────────────────────

export interface QueueInsightItem {
  insightId: string;
  courseId: string;
  courseSlug: string | null;
  courseName: string;
  lessonId: string;
  moduleIndex: number;
  lessonIndex: number;
  lessonName: string;
  moduleName: string;
  kind: IInsight['kind'];
  prompt: string;
  answer: string;
  conceptTags: string[];
  sourceBlockId: string;
  /** 'new' for items with no progress row yet. */
  isNew: boolean;
  mode: InsightMode;
  box: number;
  dueAt: string | null;
}

export interface GetInsightQueueResult {
  due: QueueInsightItem[];
  fresh: QueueInsightItem[];
  counts: {
    dueTotal: number;
    freshAvailable: number;
    learned: number;
  };
}

// ── Surfacing gates ───────────────────────────────────────
//
// The queue filters by two gates beyond scheduler due-ness:
//   1. Course is non-archived.      (blocks archived-course due items)
//   2. Lesson is 'completed' for this user.   (blocks fresh items from
//      lessons the user hasn't studied yet — an out-of-context card from an
//      unread lesson just wastes retrieval practice on unfamiliar material)
//
// Gate (1) applies to BOTH due and fresh pools. Gate (2) applies ONLY to
// fresh — due items are insights the user has already rated, so by definition
// they once engaged with the source material; we keep surfacing them.

/**
 * ObjectIds of all insights that belong to this user's non-archived courses.
 * Bounded by the user's content volume; small enough for a `$in` filter.
 */
const loadActiveInsightIds = async (userId: Types.ObjectId): Promise<Types.ObjectId[]> => {
  const activeCourses = await CourseModel.find({
    userId,
    status: { $ne: 'archived' },
  })
    .select('_id')
    .lean();
  if (activeCourses.length === 0) return [];

  const insights = await InsightModel.find({
    courseId: { $in: activeCourses.map((c) => c._id) },
  })
    .select('_id')
    .lean();

  return insights.map((i) => i._id);
};

/**
 * Set of `${courseId}:${moduleIndex}:${lessonIndex}` keys for lessons the
 * user has marked completed. Used to gate fresh-pool candidates so we never
 * surface an insight from an unread lesson.
 */
const loadCompletedLessonKeys = async (userId: Types.ObjectId): Promise<Set<string>> => {
  const rows = await UserLessonProgressModel.find({ userId, status: 'completed' })
    .select('courseId moduleIndex lessonIndex')
    .lean();
  return new Set(rows.map((r) => `${r.courseId.toString()}:${r.moduleIndex}:${r.lessonIndex}`));
};

// ── Hydration helpers ─────────────────────────────────────

type LeanInsight = IInsight & { _id: Types.ObjectId };

/**
 * Build a QueueInsightItem by joining lean insight + progress + course metadata.
 * Lookups that can't resolve (deleted course/lesson) are skipped.
 */
const toQueueItem = (
  insight: LeanInsight,
  progress: IUserInsightProgress | null,
  courseInfo: CourseInfo | undefined,
): QueueInsightItem | null => {
  if (!courseInfo) return null;
  const mod = courseInfo.modules[insight.moduleIndex];
  if (!mod) return null;
  const lesson = mod.lessons[insight.lessonIndex];
  if (!lesson) return null;

  return {
    insightId: insight._id.toString(),
    courseId: insight.courseId.toString(),
    courseSlug: courseInfo.slug,
    courseName: courseInfo.name,
    lessonId: insight.lessonId.toString(),
    moduleIndex: insight.moduleIndex,
    lessonIndex: insight.lessonIndex,
    lessonName: lesson.name,
    moduleName: mod.name,
    kind: insight.kind,
    prompt: insight.prompt,
    answer: insight.answer,
    conceptTags: insight.conceptTags,
    sourceBlockId: insight.sourceBlockId,
    isNew: !progress,
    mode: progress?.mode ?? 'tap-reveal',
    box: progress?.box ?? 0,
    dueAt: progress?.nextDue ? progress.nextDue.toISOString() : null,
  };
};

interface CourseInfo {
  slug: string | null;
  name: string;
  modules: { name: string; lessons: { name: string }[] }[];
}

/**
 * Fan-out of courseIds → { slug, name, module+lesson names } used to hydrate
 * insight rows without loading the entire course doc.
 */
const loadCourseInfo = async (courseIds: string[]): Promise<Map<string, CourseInfo>> => {
  if (courseIds.length === 0) return new Map();

  const courses = await CourseModel.find({ _id: { $in: courseIds } })
    .select('name slug structure')
    .lean();

  const map = new Map<string, CourseInfo>();
  for (const c of courses) {
    const modules = c.structure?.modules ?? [];
    map.set(c._id.toString(), {
      slug: c.slug ?? null,
      name: c.name || 'Untitled course',
      modules: modules.map((m) => ({
        name: m.name || '',
        lessons: (m.lessons ?? []).map((l) => ({ name: l.name || '' })),
      })),
    });
  }
  return map;
};

/**
 * Interleave items round-robin over courses, then over lessons inside each
 * course. Input is assumed already sorted within each course bucket.
 */
const interleaveByCourse = <T extends { courseId: string }>(items: T[]): T[] => {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    if (!buckets.has(item.courseId)) buckets.set(item.courseId, []);
    buckets.get(item.courseId)!.push(item);
  }

  const result: T[] = [];
  const courseIds = [...buckets.keys()];
  let exhausted = false;
  while (!exhausted) {
    exhausted = true;
    for (const cid of courseIds) {
      const bucket = buckets.get(cid)!;
      if (bucket.length > 0) {
        result.push(bucket.shift()!);
        exhausted = false;
      }
    }
  }
  return result;
};

// ── Main: build the daily queue ───────────────────────────

/**
 * Return the user's daily queue:
 *   • due — insights with `nextDue <= now` in non-archived courses, capped at INSIGHT_QUEUE_DUE_LIMIT
 *   • fresh — up to INSIGHT_QUEUE_FRESH_LIMIT unseen insights from non-archived
 *     courses AND from lessons the user has completed, IFF due count < INSIGHT_QUEUE_FRESH_THRESHOLD
 *
 * Items are interleaved across courses so the feed is cross-course by default.
 */
export const getInsightQueue = async (params: {
  userId: string;
}): Promise<GetInsightQueueResult> => {
  const userObjId = new mongoose.Types.ObjectId(params.userId);
  const now = new Date();

  // Scope: insights in non-archived courses only. Used as the `$in` filter
  // for every progress query below so archived content never surfaces.
  const activeInsightIds = await loadActiveInsightIds(userObjId);

  // ── Step 1: due items (scoped to active courses) ──
  const dueProgress = activeInsightIds.length === 0
    ? []
    : await UserInsightProgressModel.find({
      userId: userObjId,
      nextDue: { $lte: now },
      insightId: { $in: activeInsightIds },
    })
      .sort({ nextDue: 1 })
      .limit(INSIGHT_QUEUE_DUE_LIMIT)
      .lean();

  const totalDueCount = activeInsightIds.length === 0
    ? 0
    : await UserInsightProgressModel.countDocuments({
      userId: userObjId,
      nextDue: { $lte: now },
      insightId: { $in: activeInsightIds },
    });

  const totalLearnedCount = await UserInsightProgressModel.countDocuments({
    userId: userObjId,
    reps: { $gte: 1 },
  });

  const dueInsightIds = dueProgress.map((p) => p.insightId);
  const dueInsights = dueInsightIds.length === 0
    ? []
    : await InsightModel.find({ _id: { $in: dueInsightIds } }).lean();
  const dueInsightMap = new Map(dueInsights.map((i) => [i._id.toString(), i]));

  // ── Step 2: fresh items (active courses + completed lessons only) ──
  const shouldLoadFresh = totalDueCount < INSIGHT_QUEUE_FRESH_THRESHOLD;
  let freshInsights: LeanInsight[] = [];

  if (shouldLoadFresh && activeInsightIds.length > 0) {
    const [completedLessonKeys, seenInsightIds] = await Promise.all([
      loadCompletedLessonKeys(userObjId),
      UserInsightProgressModel.find({ userId: userObjId }).select('insightId').lean(),
    ]);

    if (completedLessonKeys.size > 0) {
      const seenSet = new Set(seenInsightIds.map((r) => r.insightId.toString()));

      // Over-fetch fresh candidates by a margin, then filter by completed
      // lessons in memory. Can't express the (courseId, moduleIndex,
      // lessonIndex) tuple filter cleanly in a single Mongo query.
      const freshCandidates = await InsightModel.find({
        _id: { $in: activeInsightIds, $nin: Array.from(seenSet).map((id) => new Types.ObjectId(id)) },
      })
        // Favor newer insights — most-recently generated lessons first.
        .sort({ createdAt: -1 })
        .limit(INSIGHT_QUEUE_FRESH_LIMIT_DEFAULT * 6)
        .lean();

      // Apply completed-lesson gate + dedup to one card per lesson.
      const perLesson = new Map<string, LeanInsight>();
      for (const i of freshCandidates) {
        const lessonKey = `${i.courseId.toString()}:${i.moduleIndex}:${i.lessonIndex}`;
        if (!completedLessonKeys.has(lessonKey)) continue;
        if (!perLesson.has(i.lessonId.toString())) perLesson.set(i.lessonId.toString(), i);
        if (perLesson.size >= INSIGHT_QUEUE_FRESH_LIMIT_DEFAULT) break;
      }
      freshInsights = [...perLesson.values()];
    }
  }

  // ── Step 3: hydrate with course/lesson names ──────
  const allCourseIds = new Set<string>();
  for (const i of dueInsights) allCourseIds.add(i.courseId.toString());
  for (const i of freshInsights) allCourseIds.add(i.courseId.toString());

  const courseInfoMap = await loadCourseInfo([...allCourseIds]);

  const progressByInsightId = new Map<string, IUserInsightProgress>();
  for (const p of dueProgress) progressByInsightId.set(p.insightId.toString(), p as IUserInsightProgress);

  const dueItems: QueueInsightItem[] = [];
  // Preserve the nextDue ordering we queried.
  for (const p of dueProgress) {
    const insight = dueInsightMap.get(p.insightId.toString());
    if (!insight) continue; // insight may have been deleted
    const info = courseInfoMap.get(insight.courseId.toString());
    const item = toQueueItem(insight, progressByInsightId.get(insight._id.toString()) ?? null, info);
    if (item) dueItems.push(item);
  }

  const freshItems: QueueInsightItem[] = [];
  for (const insight of freshInsights) {
    const info = courseInfoMap.get(insight.courseId.toString());
    const item = toQueueItem(insight, null, info);
    if (item) freshItems.push(item);
  }

  // Interleave both slices across courses.
  const interleavedDue = interleaveByCourse(dueItems);
  const interleavedFresh = interleaveByCourse(freshItems);

  return {
    due: interleavedDue,
    fresh: interleavedFresh,
    counts: {
      dueTotal: totalDueCount,
      freshAvailable: freshItems.length,
      learned: totalLearnedCount,
    },
  };
};

// ── Stats ────────────────────────────────────────────────

export interface InsightStats {
  totalInsights: number;
  totalReviewed: number;
  /** Count of insights with masteredAt !== null (never regressed away). */
  totalMastered: number;
  /** Reviews completed in the current ISO week (Mon–Sun, UTC). */
  reviewedThisWeek: number;
  /** Reviews completed in the previous ISO week. */
  reviewedLastWeek: number;
  dueToday: number;
  dueThisWeek: number;
  // Distribution of learned-insight boxes (exclude 'new').
  boxDistribution: { box: number; count: number }[];
  recentHistory: {
    date: string;
    reviews: number;
    avgRating: number;
  }[];
}

export const getInsightStats = async (params: { userId: string }): Promise<InsightStats> => {
  const userObjId = new mongoose.Types.ObjectId(params.userId);
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setUTCHours(23, 59, 59, 999);

  const endOfWeek = new Date(now);
  endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 7);

  // Week bounds (Mon–Sun, matching gamificationService for cross-surface
  // consistency). `now.getDay()` returns 0..6 (Sun..Sat); `(d+6)%7` shifts so
  // Monday = 0.
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfWeek);
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

  // Scope due-counts to non-archived courses so the dashboard agrees with
  // what the queue actually serves. totalInsights counts all content the
  // user has ever had (archived courses remain part of the learning record).
  const activeInsightIds = await loadActiveInsightIds(userObjId);

  const [totalInsights, totalReviewed, totalMastered, dueToday, dueThisWeek, allProgress] = await Promise.all([
    InsightModel.countDocuments({
      courseId: {
        $in: (await CourseModel.find({ userId: userObjId }).select('_id').lean()).map((c) => c._id),
      },
    }),
    UserInsightProgressModel.countDocuments({ userId: userObjId, reps: { $gte: 1 } }),
    UserInsightProgressModel.countDocuments({ userId: userObjId, masteredAt: { $ne: null } }),
    activeInsightIds.length === 0
      ? Promise.resolve(0)
      : UserInsightProgressModel.countDocuments({
        userId: userObjId,
        nextDue: { $lte: endOfToday },
        insightId: { $in: activeInsightIds },
      }),
    activeInsightIds.length === 0
      ? Promise.resolve(0)
      : UserInsightProgressModel.countDocuments({
        userId: userObjId,
        nextDue: { $lte: endOfWeek },
        insightId: { $in: activeInsightIds },
      }),
    UserInsightProgressModel.find({ userId: userObjId })
      .select('box history')
      .lean(),
  ]);

  // Weekly review counts computed in-memory from the already-loaded history.
  let reviewedThisWeek = 0;
  let reviewedLastWeek = 0;
  for (const p of allProgress) {
    for (const ev of p.history ?? []) {
      if (ev.ratedAt >= startOfWeek) reviewedThisWeek += 1;
      else if (ev.ratedAt >= startOfLastWeek && ev.ratedAt < startOfWeek) reviewedLastWeek += 1;
    }
  }

  // Box distribution (only learned/in-progress — exclude brand new).
  const boxBuckets = new Map<number, number>();
  for (const p of allProgress) {
    if ((p.history?.length ?? 0) === 0) continue;
    boxBuckets.set(p.box, (boxBuckets.get(p.box) ?? 0) + 1);
  }
  const boxDistribution = [...boxBuckets.entries()]
    .map(([box, count]) => ({ box, count }))
    .sort((a, b) => a.box - b.box);

  // Last 14 days of review history aggregated by UTC date string.
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 13);

  const byDate = new Map<string, { reviews: number; sumRating: number }>();
  for (const p of allProgress) {
    for (const ev of p.history ?? []) {
      if (ev.ratedAt < fourteenDaysAgo) continue;
      const dateKey = ev.ratedAt.toISOString().slice(0, 10);
      const existing = byDate.get(dateKey) ?? { reviews: 0, sumRating: 0 };
      existing.reviews += 1;
      existing.sumRating += ev.rating;
      byDate.set(dateKey, existing);
    }
  }

  const recentHistory: InsightStats['recentHistory'] = [];
  const cursor = new Date(fourteenDaysAgo);
  while (cursor <= now) {
    const key = cursor.toISOString().slice(0, 10);
    const entry = byDate.get(key);
    recentHistory.push({
      date: key,
      reviews: entry?.reviews ?? 0,
      avgRating: entry && entry.reviews > 0 ? entry.sumRating / entry.reviews : 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    totalInsights,
    totalReviewed,
    totalMastered,
    reviewedThisWeek,
    reviewedLastWeek,
    dueToday,
    dueThisWeek,
    boxDistribution,
    recentHistory,
  };
};

// ── Cheap count for dashboard widget ─────────────────────

export const getInsightsDueCount = async (params: { userId: string }): Promise<number> => {
  const userObjId = new mongoose.Types.ObjectId(params.userId);
  const activeInsightIds = await loadActiveInsightIds(userObjId);
  if (activeInsightIds.length === 0) return 0;

  return UserInsightProgressModel.countDocuments({
    userId: userObjId,
    nextDue: { $lte: new Date() },
    insightId: { $in: activeInsightIds },
  });
};
