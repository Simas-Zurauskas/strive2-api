import mongoose from 'mongoose';
import UserModuleQuizProgressModel, { IUserModuleQuizProgress, IQuizAttempt } from '@models/UserModuleQuizProgressModel';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import {
  QuizMasteryTier,
  REVIEW_INITIAL_INTERVALS,
  REVIEW_MAX_INTERVAL_DAYS,
  REVIEW_MIN_INTERVAL_DAYS,
} from '@lib/constants';
import * as gamificationService from '@services/gamificationService';

// ── Mastery tier computation ─────────────────────────────

export const computeMasteryTier = (score: number): QuizMasteryTier => {
  if (score >= 80) return 'mastered';
  if (score >= 60) return 'passed';
  return 'needs_review';
};

// Mastery tier ordering for regression detection
const TIER_ORDER: Record<QuizMasteryTier, number> = { needs_review: 0, passed: 1, mastered: 2 };

// ── Get module quiz progress ─────────────────────────────

export const getModuleQuizProgress = async (params: {
  userId: string;
  courseId: string;
  moduleIndex: number;
}): Promise<IUserModuleQuizProgress | null> => {
  return UserModuleQuizProgressModel.findOne({
    userId: params.userId,
    courseId: params.courseId,
    moduleIndex: params.moduleIndex,
  }).lean();
};

// ── Submit quiz attempt ──────────────────────────────────

interface SubmitQuizAttemptParams {
  userId: string;
  courseId: string;
  moduleIndex: number;
  responses: { questionId: string; selectedOption: number }[];
}

export interface SubmitQuizAttemptResult {
  attempt: IQuizAttempt;
  nextReviewAt: Date;
  reviewIntervalDays: number;
}

export const submitQuizAttempt = async (params: SubmitQuizAttemptParams): Promise<SubmitQuizAttemptResult> => {
  const { userId, courseId, moduleIndex, responses } = params;
  const now = new Date();

  // Load quiz content to grade answers
  const quizContent = await ModuleQuizContentModel.findOne({ courseId, moduleIndex }).lean();
  if (!quizContent) throw new Error('Quiz content not found');

  if (responses.length !== quizContent.questions.length) {
    throw new Error(`Expected ${quizContent.questions.length} responses, got ${responses.length}`);
  }

  // Grade each response
  const gradedResponses = responses.map((r) => {
    const question = quizContent.questions.find((q) => q.id === r.questionId);
    return {
      questionId: r.questionId,
      selectedOption: r.selectedOption,
      correct: question ? r.selectedOption === question.correctIndex : false,
      answeredAt: now,
    };
  });

  const correctCount = gradedResponses.filter((r) => r.correct).length;
  const score = Math.round((correctCount / quizContent.questions.length) * 100);
  const masteryTier = computeMasteryTier(score);

  // Get current progress to determine attempt number + review state
  const existing = await UserModuleQuizProgressModel.findOne({ userId, courseId, moduleIndex });
  const attemptNumber = existing ? existing.attempts.length + 1 : 1;
  const previousBestTier = existing?.bestTier ?? null;

  const attempt: IQuizAttempt = {
    attemptNumber,
    responses: gradedResponses,
    score,
    masteryTier,
    completedAt: now,
    quizVersion: quizContent.version,
  };

  // Upsert progress: push attempt, update best score/tier
  const bestScore = existing ? Math.max(existing.bestScore, score) : score;
  const bestTier = computeMasteryTier(bestScore);

  // Compute review scheduling
  let reviewIntervalDays: number;
  let consecutiveSuccesses: number;

  if (!existing || !previousBestTier) {
    // First attempt — set initial interval based on tier
    reviewIntervalDays = REVIEW_INITIAL_INTERVALS[masteryTier];
    consecutiveSuccesses = 0;
  } else if (masteryTier === 'needs_review') {
    // Still failing — keep interval short regardless of history
    reviewIntervalDays = REVIEW_INITIAL_INTERVALS.needs_review;
    consecutiveSuccesses = 0;
  } else if (TIER_ORDER[masteryTier] >= TIER_ORDER[previousBestTier]) {
    // Maintained or improved (passed/mastered) — double the interval
    const prev = existing.reviewIntervalDays || REVIEW_INITIAL_INTERVALS[previousBestTier];
    reviewIntervalDays = Math.min(prev * 2, REVIEW_MAX_INTERVAL_DAYS);
    consecutiveSuccesses = (existing.consecutiveSuccesses || 0) + 1;
  } else {
    // Regressed — halve the interval
    const prev = existing.reviewIntervalDays || REVIEW_INITIAL_INTERVALS[previousBestTier];
    reviewIntervalDays = Math.max(Math.floor(prev / 2), REVIEW_MIN_INTERVAL_DAYS);
    consecutiveSuccesses = 0;
  }

  const nextReviewAt = new Date(now.getTime() + reviewIntervalDays * 24 * 60 * 60 * 1000);

  await UserModuleQuizProgressModel.findOneAndUpdate(
    { userId, courseId, moduleIndex },
    {
      $push: { attempts: attempt },
      $set: {
        bestScore,
        bestTier,
        reviewIntervalDays,
        consecutiveSuccesses,
        nextReviewAt,
      },
      $setOnInsert: {
        userId: new mongoose.Types.ObjectId(userId),
        courseId: new mongoose.Types.ObjectId(courseId),
        moduleIndex,
      },
    },
    { upsert: true },
  );

  // Fire-and-forget gamification side effects on quiz completion
  const isReview = !!existing && attemptNumber > 1;
  const prevBestScore = existing?.bestScore ?? 0;
  gamificationService.onQuizComplete(userId, courseId, score, prevBestScore, isReview).catch(() => {});

  return { attempt, nextReviewAt, reviewIntervalDays };
};
