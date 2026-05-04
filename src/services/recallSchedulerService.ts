import { Types } from 'mongoose';
import UserRecallProgressModel, {
  IRecallReviewEvent,
  IUserRecallProgress,
} from '@models/UserRecallProgressModel';
import {
  RECALL_SKIP_DAYS,
  RecallMode,
  RecallRating,
  RecallState,
  LEITNER_BOX_INTERVAL_DAYS,
  LEITNER_MAX_BOX,
} from '@lib/recallConstants';

// ── Pure scheduling math (Leitner v0) ───────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SchedulerSnapshot {
  box: number;
  reps: number;
  lapses: number;
  state: RecallState;
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
  rating: RecallRating;
  now: Date;
}): SchedulerSnapshot => {
  let { box, reps, lapses } = snapshot;
  let state: RecallState;

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

// ── Rate a recall card (persists + returns new snapshot) ───

export interface RateRecallParams {
  userId: string;
  recallCardId: string;
  rating: RecallRating;
  /** Typed-recall match score (0..1) if the user answered via typed recall. */
  typedMatch?: number | null;
}

export interface RateRecallResult {
  progress: IUserRecallProgress;
  wasNew: boolean;
  /**
   * True exactly once per recall card, when the rating caused the first-ever
   * transition to box = LEITNER_MAX_BOX. Guaranteed race-safe: under
   * concurrent writes only one caller observes `true`. Never true on
   * re-mastery after regression.
   */
  justMastered: boolean;
}

export const rateRecall = async (params: RateRecallParams): Promise<RateRecallResult> => {
  const now = new Date();
  const userObjId = new Types.ObjectId(params.userId);
  const cardObjId = new Types.ObjectId(params.recallCardId);

  const existing = await UserRecallProgressModel.findOne({
    userId: userObjId,
    recallCardId: cardObjId,
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

  const mode: RecallMode = existing?.mode ?? 'tap-reveal';
  const event: IRecallReviewEvent = {
    ratedAt: now,
    rating: params.rating,
    elapsedDays: elapsed,
    mode,
    typedMatch: params.typedMatch ?? null,
  };

  const updated = await UserRecallProgressModel.findOneAndUpdate(
    { userId: userObjId, recallCardId: cardObjId },
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
      // `recallQueueService.getRecallStats` only read the most recent
      // two weeks of events (weekly counts + 14-day trend) plus
      // `history.length > 0` as a "has-been-reviewed" probe. Capping at
      // 200 entries preserves both signals — at Leitner's max cadence the
      // oldest 200 reviews span many years — and keeps a single progress
      // row well under 100 KB so loading `allProgress` in the stats query
      // doesn't balloon into tens of MB per power user.
      $push: { history: { $each: [event], $slice: -200 } },
      $setOnInsert: {
        userId: userObjId,
        recallCardId: cardObjId,
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
    const mastered = await UserRecallProgressModel.findOneAndUpdate(
      {
        userId: userObjId,
        recallCardId: cardObjId,
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
    progress: updated!.toJSON() as IUserRecallProgress,
    wasNew,
    justMastered,
  };
};

// ── Skip (soft defer) ────────────────────────────────────

export const skipRecall = async (params: { userId: string; recallCardId: string }): Promise<IUserRecallProgress> => {
  const now = new Date();
  const userObjId = new Types.ObjectId(params.userId);
  const cardObjId = new Types.ObjectId(params.recallCardId);

  const nextDue = new Date(now.getTime() + RECALL_SKIP_DAYS * DAY_MS);

  const updated = await UserRecallProgressModel.findOneAndUpdate(
    { userId: userObjId, recallCardId: cardObjId },
    {
      $set: { nextDue },
      $setOnInsert: {
        userId: userObjId,
        recallCardId: cardObjId,
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

  return updated!.toJSON() as IUserRecallProgress;
};

// ── Toggle mode ──────────────────────────────────────────

export const setRecallMode = async (params: {
  userId: string;
  recallCardId: string;
  mode: RecallMode;
}): Promise<IUserRecallProgress> => {
  const userObjId = new Types.ObjectId(params.userId);
  const cardObjId = new Types.ObjectId(params.recallCardId);
  const now = new Date();

  const updated = await UserRecallProgressModel.findOneAndUpdate(
    { userId: userObjId, recallCardId: cardObjId },
    {
      $set: { mode: params.mode },
      $setOnInsert: {
        userId: userObjId,
        recallCardId: cardObjId,
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

  return updated!.toJSON() as IUserRecallProgress;
};
