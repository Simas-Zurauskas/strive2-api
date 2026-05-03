/**
 * NOTE — split lines for the next maintainer.
 *
 * This file is ~660 LOC and mixes three concerns: queue mutation
 * (enqueue / dequeue / mark-due), eligibility / fresh-pool gating
 * (the `INSIGHT_QUEUE_FRESH_REASON` decision-tree logic), and Leitner
 * scheduling (next-due interval bumps). The next change here should
 * extract along this seam:
 *
 *   - `insightQueueMutationService.ts` — queue mutation entry points
 *     (the public API: enqueue / dequeue / acknowledge).
 *   - `insightSchedulingService.ts` — Leitner-v0 next-due bumps and
 *     interval bookkeeping. Pure-ish logic, easy to unit-test.
 *   - This file (renamed `insightQueueEligibility.ts`) — fresh-pool
 *     gating + decision-tree counters that already drive the
 *     `insight_queue_fresh_reason` metric.
 *
 * The split lines above respect the existing test boundary
 * (`insightQueueService.test.ts`) — that test would need to follow
 * whichever file holds the public API after the split.
 */
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
import {
  bumpInsightQueueFreshReason,
  recordInsightQueueFreshCounts,
} from '@lib/metrics';

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
    // "New" = never rated. A progress row alone isn't enough: skipInsight
    // and setInsightMode both upsert a row with reps: 0 before any rating,
    // which used to flip the badge off after a mode-toggle or skip.
    isNew: !progress || progress.reps === 0,
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

/**
 * When a `currentCourseId` is known (user is mid-lesson in a specific course),
 * place that course's items first in their input order, then round-robin
 * interleave the remaining courses behind them. Without a `currentCourseId`
 * this degrades to plain `interleaveByCourse` so global/tab views are
 * unaffected.
 *
 * Preserves input relative ordering within the active-course slice — the
 * caller has already sorted by due-ness (for the due pool) or by
 * createdAt-desc (for the fresh pool).
 */
const partitionByCourse = ({
  items,
  currentCourseId,
}: {
  items: QueueInsightItem[];
  currentCourseId: string | undefined;
}): QueueInsightItem[] => {
  if (!currentCourseId) return interleaveByCourse(items);
  const active: QueueInsightItem[] = [];
  const rest: QueueInsightItem[] = [];
  for (const item of items) {
    if (item.courseId === currentCourseId) active.push(item);
    else rest.push(item);
  }
  return [...active, ...interleaveByCourse(rest)];
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
  currentCourseId?: string;
}): Promise<GetInsightQueueResult> => {
  const userObjId = new mongoose.Types.ObjectId(params.userId);
  const { currentCourseId } = params;
  const now = new Date();

  // Counters observed across the fresh-pool decision path. Recorded on all
  // exit branches below so `/metrics` shows the distribution — essential
  // for diagnosing "0 fresh despite Learned: 28" in production.
  let completedLessonCount = 0;
  let candidateCount = 0;

  // `totalLearnedCount` is independent of everything else — kick it off
  // immediately so it can complete in parallel with the two queries that
  // gate on `activeInsightIds`.
  const totalLearnedCountP = UserInsightProgressModel.countDocuments({
    userId: userObjId,
    reps: { $gte: 1 },
  });

  // Scope: insights in non-archived courses only. Used as the `$in` filter
  // for every progress query below so archived content never surfaces.
  const activeInsightIds = await loadActiveInsightIds(userObjId);

  // ── Step 1: due items + total-due-count (both scoped to active courses) ──
  // Run in parallel: find-with-limit and countDocuments are the same filter
  // but return different shapes, so they can't be combined server-side.
  type LeanProgress = IUserInsightProgress & { _id: Types.ObjectId };
  const [dueProgress, totalDueCount, totalLearnedCount] = await Promise.all([
    activeInsightIds.length === 0
      ? Promise.resolve<LeanProgress[]>([])
      : UserInsightProgressModel.find({
        userId: userObjId,
        nextDue: { $lte: now },
        insightId: { $in: activeInsightIds },
      })
        .sort({ nextDue: 1 })
        .limit(INSIGHT_QUEUE_DUE_LIMIT)
        .lean<LeanProgress[]>(),
    activeInsightIds.length === 0
      ? Promise.resolve(0)
      : UserInsightProgressModel.countDocuments({
        userId: userObjId,
        nextDue: { $lte: now },
        insightId: { $in: activeInsightIds },
      }),
    totalLearnedCountP,
  ]);

  const dueInsightIds = dueProgress.map((p) => p.insightId);
  const dueInsights = dueInsightIds.length === 0
    ? []
    : await InsightModel.find({ _id: { $in: dueInsightIds } }).lean();
  const dueInsightMap = new Map(dueInsights.map((i) => [i._id.toString(), i]));

  // ── Step 2: fresh items (active courses + completed lessons only) ──
  const shouldLoadFresh = totalDueCount < INSIGHT_QUEUE_FRESH_THRESHOLD;
  let freshInsights: LeanInsight[] = [];
  // Fresh-pool decision path — set on every branch. `bumpInsightQueueFreshReason`
  // is invoked once at the bottom so the distribution surfaces in /metrics.
  let freshReason: Parameters<typeof bumpInsightQueueFreshReason>[0];

  if (!shouldLoadFresh) {
    // Plenty of due items already — don't even probe the fresh pool.
    freshReason = 'due_gated_fresh_skipped';
  } else if (activeInsightIds.length === 0) {
    freshReason = 'no_active_insights';
  } else {
    const [completedLessonKeys, seenInsightIds] = await Promise.all([
      loadCompletedLessonKeys(userObjId),
      UserInsightProgressModel.find({ userId: userObjId }).select('insightId').lean(),
    ]);
    completedLessonCount = completedLessonKeys.size;

    if (completedLessonKeys.size === 0) {
      freshReason = 'no_completed_lessons';
    } else {
      const seenIdList = Array.from(
        new Set(seenInsightIds.map((r) => r.insightId.toString())),
      ).map((id) => new Types.ObjectId(id));

      // Over-fetch fresh candidates by a margin, then filter by completed
      // lessons in memory. Can't express the (courseId, moduleIndex,
      // lessonIndex) tuple filter cleanly in a single Mongo query.
      //
      // When `currentCourseId` is present we run the same find twice —
      // once constrained to the active course, once for everything else —
      // so the active course's candidates consistently win the `perLesson`
      // dedup race even when the global createdAt-desc ordering would have
      // placed another course first. Keeps the gate + cap logic unchanged.
      const overFetch = INSIGHT_QUEUE_FRESH_LIMIT_DEFAULT * 6;
      let freshCandidates: LeanInsight[];
      if (currentCourseId) {
        const activeCourseObjId = new Types.ObjectId(currentCourseId);
        const [activeCandidates, otherCandidates] = await Promise.all([
          InsightModel.find({
            _id: { $in: activeInsightIds, $nin: seenIdList },
            courseId: activeCourseObjId,
          })
            .sort({ createdAt: -1 })
            .limit(overFetch)
            .lean(),
          InsightModel.find({
            _id: { $in: activeInsightIds, $nin: seenIdList },
            courseId: { $ne: activeCourseObjId },
          })
            .sort({ createdAt: -1 })
            .limit(overFetch)
            .lean(),
        ]);
        freshCandidates = [...activeCandidates, ...otherCandidates];
      } else {
        freshCandidates = await InsightModel.find({
          _id: { $in: activeInsightIds, $nin: seenIdList },
        })
          // Favor newer insights — most-recently generated lessons first.
          .sort({ createdAt: -1 })
          .limit(overFetch)
          .lean();
      }
      candidateCount = freshCandidates.length;

      if (freshCandidates.length === 0) {
        freshReason = 'candidates_zero';
      } else {
        // Apply completed-lesson gate + dedup to one card per lesson.
        const perLesson = new Map<string, LeanInsight>();
        for (const i of freshCandidates) {
          const lessonKey = `${i.courseId.toString()}:${i.moduleIndex}:${i.lessonIndex}`;
          if (!completedLessonKeys.has(lessonKey)) continue;
          if (!perLesson.has(i.lessonId.toString())) perLesson.set(i.lessonId.toString(), i);
          if (perLesson.size >= INSIGHT_QUEUE_FRESH_LIMIT_DEFAULT) break;
        }
        freshInsights = [...perLesson.values()];
        freshReason = freshInsights.length === 0 ? 'all_gated_by_lesson' : 'ok';
      }
    }
  }

  bumpInsightQueueFreshReason(freshReason);
  recordInsightQueueFreshCounts({
    activeInsightCount: activeInsightIds.length,
    completedLessonCount,
    candidateCount,
    freshOutCount: freshInsights.length,
  });

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

  // Partition-then-interleave: when a `currentCourseId` is known, the active
  // course's items are placed first; otherwise fall back to pure
  // round-robin interleave across courses.
  const orderedDue = partitionByCourse({ items: dueItems, currentCourseId });
  const orderedFresh = partitionByCourse({ items: freshItems, currentCourseId });

  return {
    due: orderedDue,
    fresh: orderedFresh,
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

  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 13);

  // Load the user's courses once. Previous implementation did this twice:
  // once via loadActiveInsightIds (filtered to non-archived) and again inline
  // inside Promise.all for totalInsights (all statuses). Keeping the `status`
  // field lets us partition into active and all-courses sets in memory.
  //
  // totalInsights counts every card the user has ever had — archived content
  // stays part of the learning record. Active set scopes the scheduler
  // queries (dueToday/dueThisWeek) so archived courses don't nag.
  const allCourses = await CourseModel.find({ userId: userObjId })
    .select('_id status')
    .lean();
  const allCourseIds = allCourses.map((c) => c._id);
  const activeCourseIds = allCourses
    .filter((c) => c.status !== 'archived')
    .map((c) => c._id);

  const activeInsightIds = activeCourseIds.length === 0
    ? []
    : (
      await InsightModel.find({ courseId: { $in: activeCourseIds } })
        .select('_id')
        .lean()
    ).map((i) => i._id);

  // Single $facet replaces the previous pattern of loading every progress
  // row's full history[] array into Node memory and iterating three times.
  // MongoDB does the grouping; we just fill 14-day zeros on the JS side.
  const historyFacetP = UserInsightProgressModel.aggregate<{
    byBox: { _id: number; count: number }[];
    weekly: { _id: null; thisWeek: number; lastWeek: number }[];
    daily: { _id: string; reviews: number; sumRating: number }[];
  }>([
    { $match: { userId: userObjId } },
    {
      $facet: {
        // Box distribution across rows that have been reviewed at least once.
        // `history.0` exists <=> history.length > 0 — equivalent to the old
        // `if ((p.history?.length ?? 0) === 0) continue` filter.
        byBox: [
          { $match: { 'history.0': { $exists: true } } },
          { $group: { _id: '$box', count: { $sum: 1 } } },
        ],
        // Weekly counts: pre-filter docs whose array contains any event in
        // the last two weeks, unwind, re-filter the unwound events, then
        // partition via conditional $sum. One pass for both weeks.
        weekly: [
          { $match: { 'history.ratedAt': { $gte: startOfLastWeek } } },
          { $unwind: '$history' },
          { $match: { 'history.ratedAt': { $gte: startOfLastWeek } } },
          {
            $group: {
              _id: null,
              thisWeek: {
                $sum: { $cond: [{ $gte: ['$history.ratedAt', startOfWeek] }, 1, 0] },
              },
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
        ],
        // 14-day histogram bucketed by UTC date. Matches the previous
        // `ratedAt.toISOString().slice(0, 10)` grouping behavior.
        daily: [
          { $match: { 'history.ratedAt': { $gte: fourteenDaysAgo } } },
          { $unwind: '$history' },
          { $match: { 'history.ratedAt': { $gte: fourteenDaysAgo } } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$history.ratedAt',
                  timezone: 'UTC',
                },
              },
              reviews: { $sum: 1 },
              sumRating: { $sum: '$history.rating' },
            },
          },
        ],
      },
    },
  ]);

  const [
    totalInsights,
    totalReviewed,
    totalMastered,
    dueToday,
    dueThisWeek,
    historyFacet,
  ] = await Promise.all([
    allCourseIds.length === 0
      ? Promise.resolve(0)
      : InsightModel.countDocuments({ courseId: { $in: allCourseIds } }),
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
    historyFacetP,
  ]);

  const facet = historyFacet[0];
  const reviewedThisWeek = facet?.weekly[0]?.thisWeek ?? 0;
  const reviewedLastWeek = facet?.weekly[0]?.lastWeek ?? 0;

  const boxDistribution = (facet?.byBox ?? [])
    .map((b) => ({ box: b._id, count: b.count }))
    .sort((a, b) => a.box - b.box);

  // Hydrate a dense 14-day series from the daily facet. Days with no
  // reviews show up as zeros so the client can render a continuous bar.
  const byDate = new Map<string, { reviews: number; sumRating: number }>();
  for (const d of facet?.daily ?? []) {
    byDate.set(d._id, { reviews: d.reviews, sumRating: d.sumRating });
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
