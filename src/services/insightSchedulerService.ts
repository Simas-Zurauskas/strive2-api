import { Types } from 'mongoose';
import UserInsightProgressModel, {
  IInsightReviewEvent,
  IUserInsightProgress,
} from '@models/UserInsightProgressModel';
import {
  INSIGHT_SKIP_DAYS,
  InsightMode,
  InsightRating,
  InsightState,
  LEITNER_BOX_INTERVAL_DAYS,
  LEITNER_MAX_BOX,
} from '@lib/insightConstants';

// ── Pure scheduling math (Leitner v0) ───────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SchedulerSnapshot {
  box: number;
  reps: number;
  lapses: number;
  state: InsightState;
  lastReview: Date | null;
  nextDue: Date;
}

/**
 * Apply a rating to the current state and return the new state.
 * Pure function — no DB side effects.
 *
 * Rating semantics:
 *  1 (Again): hard failure. Box reset to 0, state → relearning, lapse++.
 *  2 (Hard):  struggled. Box stays (min 0), state → review/learning.
 *  3 (Good):  standard success. Box + 1 (capped), state → review.
 *  4 (Easy):  big jump. Box + 2 (capped), state → review.
 */
export const applyRating = ({
  snapshot,
  rating,
  now,
}: {
  snapshot: SchedulerSnapshot;
  rating: InsightRating;
  now: Date;
}): SchedulerSnapshot => {
  let { box, reps, lapses } = snapshot;
  let state: InsightState;

  switch (rating) {
    case 1:
      box = 0;
      reps = 0;
      lapses += 1;
      state = 'relearning';
      break;
    case 2:
      // Stay in place but count as a rep in the learning direction.
      box = Math.max(0, box);
      reps += 1;
      state = snapshot.state === 'new' ? 'learning' : 'review';
      break;
    case 3:
      box = Math.min(LEITNER_MAX_BOX, box + 1);
      reps += 1;
      state = 'review';
      break;
    case 4:
      box = Math.min(LEITNER_MAX_BOX, box + 2);
      reps += 1;
      state = 'review';
      break;
  }

  const intervalDays = LEITNER_BOX_INTERVAL_DAYS[box] ?? LEITNER_BOX_INTERVAL_DAYS[0];
  const nextDue = new Date(now.getTime() + intervalDays * DAY_MS);

  return {
    box,
    reps,
    lapses,
    state,
    lastReview: now,
    nextDue,
  };
};

/**
 * Days between two dates, clamped to a minimum of 0 to avoid negative history
 * entries when `last` is null (first review) or in the future (clock drift).
 */
const elapsedDays = ({ last, now }: { last: Date | null; now: Date }): number => {
  if (!last) return 0;
  return Math.max(0, Math.floor((now.getTime() - last.getTime()) / DAY_MS));
};

// ── Rate an insight (persists + returns new snapshot) ───

export interface RateInsightParams {
  userId: string;
  insightId: string;
  rating: InsightRating;
  /** Typed-recall match score (0..1) if the user answered via typed recall. */
  typedMatch?: number | null;
}

export interface RateInsightResult {
  progress: IUserInsightProgress;
  wasNew: boolean;
  /**
   * True exactly once per insight, when the rating caused the first-ever
   * transition to box = LEITNER_MAX_BOX. Guaranteed race-safe: under
   * concurrent writes only one caller observes `true`. Never true on
   * re-mastery after regression.
   */
  justMastered: boolean;
}

export const rateInsight = async (params: RateInsightParams): Promise<RateInsightResult> => {
  const now = new Date();
  const userObjId = new Types.ObjectId(params.userId);
  const insightObjId = new Types.ObjectId(params.insightId);

  const existing = await UserInsightProgressModel.findOne({
    userId: userObjId,
    insightId: insightObjId,
  });

  const wasNew = !existing;

  const currentSnapshot: SchedulerSnapshot = existing
    ? {
      box: existing.box,
      reps: existing.reps,
      lapses: existing.lapses,
      state: existing.state,
      lastReview: existing.lastReview,
      nextDue: existing.nextDue,
    }
    : {
      box: 0,
      reps: 0,
      lapses: 0,
      state: 'new',
      lastReview: null,
      nextDue: now,
    };

  const elapsed = elapsedDays({ last: currentSnapshot.lastReview, now });
  const next = applyRating({ snapshot: currentSnapshot, rating: params.rating, now });

  const mode: InsightMode = existing?.mode ?? 'tap-reveal';
  const event: IInsightReviewEvent = {
    ratedAt: now,
    rating: params.rating,
    elapsedDays: elapsed,
    mode,
    typedMatch: params.typedMatch ?? null,
  };

  const updated = await UserInsightProgressModel.findOneAndUpdate(
    { userId: userObjId, insightId: insightObjId },
    {
      $set: {
        box: next.box,
        reps: next.reps,
        lapses: next.lapses,
        state: next.state,
        lastReview: next.lastReview,
        nextDue: next.nextDue,
      },
      // Rolling window on history[]. Downstream consumers in
      // `insightQueueService.getInsightStats` only read the most recent
      // two weeks of events (weekly counts + 14-day trend) plus
      // `history.length > 0` as a "has-been-reviewed" probe. Capping at
      // 200 entries preserves both signals — at Leitner's max cadence the
      // oldest 200 reviews span many years — and keeps a single progress
      // row well under 100 KB so loading `allProgress` in the stats query
      // doesn't balloon into tens of MB per power user.
      $push: { history: { $each: [event], $slice: -200 } },
      $setOnInsert: {
        userId: userObjId,
        insightId: insightObjId,
        mode,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  // ── Mastery detection (race-safe) ──────────────────
  // Only one concurrent writer can satisfy the filter
  // `{ masteredAt: null, box: LEITNER_MAX_BOX }` and set masteredAt, so we
  // know a non-null return means THIS call won the mastery race.
  let justMastered = false;
  if (updated!.box === LEITNER_MAX_BOX && !updated!.masteredAt) {
    const mastered = await UserInsightProgressModel.findOneAndUpdate(
      {
        userId: userObjId,
        insightId: insightObjId,
        masteredAt: null,
        box: LEITNER_MAX_BOX,
      },
      { $set: { masteredAt: now } },
      { returnDocument: 'after' },
    );
    if (mastered) {
      justMastered = true;
      updated!.masteredAt = mastered.masteredAt;
    }
  }

  return {
    progress: updated!.toJSON() as IUserInsightProgress,
    wasNew,
    justMastered,
  };
};

// ── Skip (soft defer) ────────────────────────────────────

export const skipInsight = async (params: { userId: string; insightId: string }): Promise<IUserInsightProgress> => {
  const now = new Date();
  const userObjId = new Types.ObjectId(params.userId);
  const insightObjId = new Types.ObjectId(params.insightId);

  const nextDue = new Date(now.getTime() + INSIGHT_SKIP_DAYS * DAY_MS);

  const updated = await UserInsightProgressModel.findOneAndUpdate(
    { userId: userObjId, insightId: insightObjId },
    {
      $set: { nextDue },
      $setOnInsert: {
        userId: userObjId,
        insightId: insightObjId,
        box: 0,
        reps: 0,
        lapses: 0,
        state: 'new',
        mode: 'tap-reveal',
        lastReview: null,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  return updated!.toJSON() as IUserInsightProgress;
};

// ── Toggle mode ──────────────────────────────────────────

export const setInsightMode = async (params: {
  userId: string;
  insightId: string;
  mode: InsightMode;
}): Promise<IUserInsightProgress> => {
  const userObjId = new Types.ObjectId(params.userId);
  const insightObjId = new Types.ObjectId(params.insightId);
  const now = new Date();

  const updated = await UserInsightProgressModel.findOneAndUpdate(
    { userId: userObjId, insightId: insightObjId },
    {
      $set: { mode: params.mode },
      $setOnInsert: {
        userId: userObjId,
        insightId: insightObjId,
        box: 0,
        reps: 0,
        lapses: 0,
        state: 'new',
        lastReview: null,
        nextDue: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  return updated!.toJSON() as IUserInsightProgress;
};
