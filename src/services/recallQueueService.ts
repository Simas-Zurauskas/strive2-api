/**
 * NOTE — split lines for the next maintainer.
 *
 * This file is ~660 LOC and mixes three concerns: queue mutation
 * (enqueue / dequeue / mark-due), eligibility / fresh-pool gating
 * (the `INSIGHT_QUEUE_FRESH_REASON` decision-tree logic), and Leitner
 * scheduling (next-due interval bumps). The next change here should
 * extract along this seam:
 *
 *   - `recallQueueMutationService.ts` — queue mutation entry points
 *     (the public API: enqueue / dequeue / acknowledge).
 *   - `recallSchedulingService.ts` — Leitner-v0 next-due bumps and
 *     interval bookkeeping. Pure-ish logic, easy to unit-test.
 *   - This file (renamed `recallQueueEligibility.ts`) — fresh-pool
 *     gating + decision-tree counters that already drive the
 *     `recall_queue_fresh_reason` metric.
 *
 * The split lines above respect the existing test boundary
 * (`recallQueueService.test.ts`) — that test would need to follow
 * whichever file holds the public API after the split.
 */
import mongoose, { Types } from 'mongoose';
import RecallCardModel, { IRecallCard } from '@models/RecallCardModel';
import UserRecallProgressModel, {
  IUserRecallProgress,
} from '@models/UserRecallProgressModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import CourseModel from '@models/CourseModel';
import {
  RECALL_QUEUE_DUE_LIMIT,
  RECALL_QUEUE_FRESH_LIMIT_DEFAULT,
  RECALL_QUEUE_FRESH_THRESHOLD,
  RecallMode,
} from '@lib/recallConstants';
import {
  bumpRecallQueueFreshReason,
  recordRecallQueueFreshCounts,
} from '@lib/metrics';
import { lifecycleLog } from '@lib/loggers';

// Per-user safety cap on the recall card + progress queries below. The intent
// is fail-soft on a runaway power user (e.g. 100 courses × 100 recall cards →
// 10K rows; an attacker driving the create path further could push this
// higher) so we never hydrate hundreds of thousands of rows into Node and
// drain the Mongo connection pool. 50_000 is well above any plausible
// legitimate user — anyone hitting it is either pathological or worth a
// product conversation about archive-on-completion semantics. We log on
// cap-hit so the boundary is observable.
const RECALL_USER_QUERY_CAP = 50_000;

const logIfCapHit = (label: string, count: number, userId: string): void => {
  if (count >= RECALL_USER_QUERY_CAP) {
    lifecycleLog.warn(
      `recall-cap-hit label=${label} user=${userId} count=${count} cap=${RECALL_USER_QUERY_CAP} — some recall cards may be invisible to this query`,
    );
  }
};

// ── Types ──────────────────────────────────────────────────

export interface QueueRecallCardItem {
  recallCardId: string;
  courseId: string;
  courseSlug: string | null;
  courseName: string;
  lessonId: string;
  moduleIndex: number;
  lessonIndex: number;
  lessonName: string;
  moduleName: string;
  kind: IRecallCard['kind'];
  prompt: string;
  answer: string;
  conceptTags: string[];
  sourceBlockId: string;
  /** 'new' for items with no progress row yet. */
  isNew: boolean;
  mode: RecallMode;
  box: number;
  dueAt: string | null;
}

export interface GetRecallQueueResult {
  due: QueueRecallCardItem[];
  fresh: QueueRecallCardItem[];
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
// fresh — due items are recall cards the user has already rated, so by definition
// they once engaged with the source material; we keep surfacing them.

/**
 * ObjectIds of all recall cards that belong to this user's non-archived courses.
 * Bounded by the user's content volume; small enough for a `$in` filter.
 */
const loadActiveCardIds = async (userId: Types.ObjectId): Promise<Types.ObjectId[]> => {
  const activeCourses = await CourseModel.find({
    userId,
    status: { $ne: 'archived' },
  })
    .select('_id')
    .lean();
  if (activeCourses.length === 0) return [];

  const cards = await RecallCardModel.find({
    courseId: { $in: activeCourses.map((c) => c._id) },
  })
    .select('_id')
    .limit(RECALL_USER_QUERY_CAP)
    .lean();

  logIfCapHit('loadActiveCardIds', cards.length, userId.toString());
  return cards.map((i) => i._id);
};

/**
 * Set of `${courseId}:${moduleIndex}:${lessonIndex}` keys for lessons the
 * user has marked completed. Used to gate fresh-pool candidates so we never
 * surface a recall card from an unread lesson.
 */
const loadCompletedLessonKeys = async (userId: Types.ObjectId): Promise<Set<string>> => {
  const rows = await UserLessonProgressModel.find({ userId, status: 'completed' })
    .select('courseId moduleIndex lessonIndex')
    .lean();
  return new Set(rows.map((r) => `${r.courseId.toString()}:${r.moduleIndex}:${r.lessonIndex}`));
};

// ── Hydration helpers ─────────────────────────────────────

type LeanRecallCard = IRecallCard & { _id: Types.ObjectId };

/**
 * Build a QueueRecallCardItem by joining lea recall card + progress + course metadata.
 * Lookups that can't resolve (deleted course/lesson) are skipped.
 */
const toQueueItem = (
  card: LeanRecallCard,
  progress: IUserRecallProgress | null,
  courseInfo: CourseInfo | undefined,
): QueueRecallCardItem | null => {
  if (!courseInfo) return null;
  const mod = courseInfo.modules[card.moduleIndex];
  if (!mod) return null;
  const lesson = mod.lessons[card.lessonIndex];
  if (!lesson) return null;

  return {
    recallCardId: card._id.toString(),
    courseId: card.courseId.toString(),
    courseSlug: courseInfo.slug,
    courseName: courseInfo.name,
    lessonId: card.lessonId.toString(),
    moduleIndex: card.moduleIndex,
    lessonIndex: card.lessonIndex,
    lessonName: lesson.name,
    moduleName: mod.name,
    kind: card.kind,
    prompt: card.prompt,
    answer: card.answer,
    conceptTags: card.conceptTags,
    sourceBlockId: card.sourceBlockId,
    // "New" = never rated. A progress row alone isn't enough: skipRecall
    // and setRecallMode both upsert a row with reps: 0 before any rating,
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
 * recall card rows without loading the entire course doc.
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
  items: QueueRecallCardItem[];
  currentCourseId: string | undefined;
}): QueueRecallCardItem[] => {
  if (!currentCourseId) return interleaveByCourse(items);
  const active: QueueRecallCardItem[] = [];
  const rest: QueueRecallCardItem[] = [];
  for (const item of items) {
    if (item.courseId === currentCourseId) active.push(item);
    else rest.push(item);
  }
  return [...active, ...interleaveByCourse(rest)];
};

// ── Main: build the daily queue ───────────────────────────

/**
 * Return the user's daily queue:
 *   • due — recall cards with `nextDue <= now` in non-archived courses, capped at RECALL_QUEUE_DUE_LIMIT
 *   • fresh — up to RECALL_QUEUE_FRESH_LIMIT unseen recall cards from non-archived
 *     courses AND from lessons the user has completed, IFF due count < RECALL_QUEUE_FRESH_THRESHOLD
 *
 * Items are interleaved across courses so the feed is cross-course by default.
 */
export const getRecallQueue = async (params: {
  userId: string;
  currentCourseId?: string;
}): Promise<GetRecallQueueResult> => {
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
  // gate on `activeCardIds`.
  const totalLearnedCountP = UserRecallProgressModel.countDocuments({
    userId: userObjId,
    reps: { $gte: 1 },
  });

  // Scope: recall cards in non-archived courses only. Used as the `$in` filter
  // for every progress query below so archived content never surfaces.
  const activeCardIds = await loadActiveCardIds(userObjId);

  // ── Step 1: due items + total-due-count (both scoped to active courses) ──
  // Run in parallel: find-with-limit and countDocuments are the same filter
  // but return different shapes, so they can't be combined server-side.
  type LeanProgress = IUserRecallProgress & { _id: Types.ObjectId };
  const [dueProgress, totalDueCount, totalLearnedCount] = await Promise.all([
    activeCardIds.length === 0
      ? Promise.resolve<LeanProgress[]>([])
      : UserRecallProgressModel.find({
        userId: userObjId,
        nextDue: { $lte: now },
        recallCardId: { $in: activeCardIds },
      })
        .sort({ nextDue: 1 })
        .limit(RECALL_QUEUE_DUE_LIMIT)
        .lean<LeanProgress[]>(),
    activeCardIds.length === 0
      ? Promise.resolve(0)
      : UserRecallProgressModel.countDocuments({
        userId: userObjId,
        nextDue: { $lte: now },
        recallCardId: { $in: activeCardIds },
      }),
    totalLearnedCountP,
  ]);

  const dueCardIds = dueProgress.map((p) => p.recallCardId);
  const dueCards = dueCardIds.length === 0
    ? []
    : await RecallCardModel.find({ _id: { $in: dueCardIds } }).lean();
  const dueCardMap = new Map(dueCards.map((i) => [i._id.toString(), i]));

  // ── Step 2: fresh items (active courses + completed lessons only) ──
  const shouldLoadFresh = totalDueCount < RECALL_QUEUE_FRESH_THRESHOLD;
  let freshCards: LeanRecallCard[] = [];
  // Fresh-pool decision path — set on every branch. `bumpRecallQueueFreshReason`
  // is invoked once at the bottom so the distribution surfaces in /metrics.
  let freshReason: Parameters<typeof bumpRecallQueueFreshReason>[0];

  if (!shouldLoadFresh) {
    // Plenty of due items already — don't even probe the fresh pool.
    freshReason = 'due_gated_fresh_skipped';
  } else if (activeCardIds.length === 0) {
    freshReason = 'no_active_recall_cards';
  } else {
    const [completedLessonKeys, seenCardIds] = await Promise.all([
      loadCompletedLessonKeys(userObjId),
      UserRecallProgressModel.find({ userId: userObjId })
        .select('recallCardId')
        .limit(RECALL_USER_QUERY_CAP)
        .lean(),
    ]);
    logIfCapHit('seenCardIds', seenCardIds.length, userObjId.toString());
    completedLessonCount = completedLessonKeys.size;

    if (completedLessonKeys.size === 0) {
      freshReason = 'no_completed_lessons';
    } else {
      const seenIdList = Array.from(
        new Set(seenCardIds.map((r) => r.recallCardId.toString())),
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
      const overFetch = RECALL_QUEUE_FRESH_LIMIT_DEFAULT * 6;
      let freshCandidates: LeanRecallCard[];
      if (currentCourseId) {
        const activeCourseObjId = new Types.ObjectId(currentCourseId);
        const [activeCandidates, otherCandidates] = await Promise.all([
          RecallCardModel.find({
            _id: { $in: activeCardIds, $nin: seenIdList },
            courseId: activeCourseObjId,
          })
            .sort({ createdAt: -1 })
            .limit(overFetch)
            .lean(),
          RecallCardModel.find({
            _id: { $in: activeCardIds, $nin: seenIdList },
            courseId: { $ne: activeCourseObjId },
          })
            .sort({ createdAt: -1 })
            .limit(overFetch)
            .lean(),
        ]);
        freshCandidates = [...activeCandidates, ...otherCandidates];
      } else {
        freshCandidates = await RecallCardModel.find({
          _id: { $in: activeCardIds, $nin: seenIdList },
        })
          // Favor newer recall cards — most-recently generated lessons first.
          .sort({ createdAt: -1 })
          .limit(overFetch)
          .lean();
      }
      candidateCount = freshCandidates.length;

      if (freshCandidates.length === 0) {
        freshReason = 'candidates_zero';
      } else {
        // Apply completed-lesson gate + dedup to one card per lesson.
        const perLesson = new Map<string, LeanRecallCard>();
        for (const i of freshCandidates) {
          const lessonKey = `${i.courseId.toString()}:${i.moduleIndex}:${i.lessonIndex}`;
          if (!completedLessonKeys.has(lessonKey)) continue;
          if (!perLesson.has(i.lessonId.toString())) perLesson.set(i.lessonId.toString(), i);
          if (perLesson.size >= RECALL_QUEUE_FRESH_LIMIT_DEFAULT) break;
        }
        freshCards = [...perLesson.values()];
        freshReason = freshCards.length === 0 ? 'all_gated_by_lesson' : 'ok';
      }
    }
  }

  bumpRecallQueueFreshReason(freshReason);
  recordRecallQueueFreshCounts({
    activeCardCount: activeCardIds.length,
    completedLessonCount,
    candidateCount,
    freshOutCount: freshCards.length,
  });

  // ── Step 3: hydrate with course/lesson names ──────
  const allCourseIds = new Set<string>();
  for (const i of dueCards) allCourseIds.add(i.courseId.toString());
  for (const i of freshCards) allCourseIds.add(i.courseId.toString());

  const courseInfoMap = await loadCourseInfo([...allCourseIds]);

  const progressByCardId = new Map<string, IUserRecallProgress>();
  for (const p of dueProgress) progressByCardId.set(p.recallCardId.toString(), p as IUserRecallProgress);

  const dueItems: QueueRecallCardItem[] = [];
  // Preserve the nextDue ordering we queried.
  for (const p of dueProgress) {
    const card = dueCardMap.get(p.recallCardId.toString());
    if (!card) continue; // recall card may have been deleted
    const info = courseInfoMap.get(card.courseId.toString());
    const item = toQueueItem(card, progressByCardId.get(card._id.toString()) ?? null, info);
    if (item) dueItems.push(item);
  }

  const freshItems: QueueRecallCardItem[] = [];
  for (const card of freshCards) {
    const info = courseInfoMap.get(card.courseId.toString());
    const item = toQueueItem(card, null, info);
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

export interface RecallStats {
  totalCards: number;
  totalReviewed: number;
  /** Count of recall cards with masteredAt !== null (never regressed away). */
  totalMastered: number;
  /** Reviews completed in the current ISO week (Mon–Sun, UTC). */
  reviewedThisWeek: number;
  /** Reviews completed in the previous ISO week. */
  reviewedLastWeek: number;
  dueToday: number;
  dueThisWeek: number;
  // Distribution of learned-card boxes (exclude 'new').
  boxDistribution: { box: number; count: number }[];
  recentHistory: {
    date: string;
    reviews: number;
    avgRating: number;
  }[];
}

export const getRecallStats = async (params: { userId: string }): Promise<RecallStats> => {
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
  // once via loadActiveCardIds (filtered to non-archived) and again inline
  // inside Promise.all for totalCards (all statuses). Keeping the `status`
  // field lets us partition into active and all-courses sets in memory.
  //
  // totalCards counts every card the user has ever had — archived content
  // stays part of the learning record. Active set scopes the scheduler
  // queries (dueToday/dueThisWeek) so archived courses don't nag.
  const allCourses = await CourseModel.find({ userId: userObjId })
    .select('_id status')
    .lean();
  const allCourseIds = allCourses.map((c) => c._id);
  const activeCourseIds = allCourses
    .filter((c) => c.status !== 'archived')
    .map((c) => c._id);

  const activeCardIds = activeCourseIds.length === 0
    ? []
    : await (async () => {
      const rows = await RecallCardModel.find({ courseId: { $in: activeCourseIds } })
        .select('_id')
        .limit(RECALL_USER_QUERY_CAP)
        .lean();
      logIfCapHit('getRecallStats:activeCardIds', rows.length, userObjId.toString());
      return rows.map((i) => i._id);
    })();

  // Single $facet replaces the previous pattern of loading every progress
  // row's full history[] array into Node memory and iterating three times.
  // MongoDB does the grouping; we just fill 14-day zeros on the JS side.
  const historyFacetP = UserRecallProgressModel.aggregate<{
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
    totalCards,
    totalReviewed,
    totalMastered,
    dueToday,
    dueThisWeek,
    historyFacet,
  ] = await Promise.all([
    allCourseIds.length === 0
      ? Promise.resolve(0)
      : RecallCardModel.countDocuments({ courseId: { $in: allCourseIds } }),
    UserRecallProgressModel.countDocuments({ userId: userObjId, reps: { $gte: 1 } }),
    UserRecallProgressModel.countDocuments({ userId: userObjId, masteredAt: { $ne: null } }),
    activeCardIds.length === 0
      ? Promise.resolve(0)
      : UserRecallProgressModel.countDocuments({
        userId: userObjId,
        nextDue: { $lte: endOfToday },
        recallCardId: { $in: activeCardIds },
      }),
    activeCardIds.length === 0
      ? Promise.resolve(0)
      : UserRecallProgressModel.countDocuments({
        userId: userObjId,
        nextDue: { $lte: endOfWeek },
        recallCardId: { $in: activeCardIds },
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

  const recentHistory: RecallStats['recentHistory'] = [];
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
    totalCards,
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

export const getRecallDueCount = async (params: { userId: string }): Promise<number> => {
  const userObjId = new mongoose.Types.ObjectId(params.userId);
  const activeCardIds = await loadActiveCardIds(userObjId);
  if (activeCardIds.length === 0) return 0;

  return UserRecallProgressModel.countDocuments({
    userId: userObjId,
    nextDue: { $lte: new Date() },
    recallCardId: { $in: activeCardIds },
  });
};
