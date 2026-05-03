import mongoose from 'mongoose';
import * as Sentry from '@sentry/node';
import UserModel from '@models/UserModel';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { emitCreditsUpdated } from '@lib/creditSocket';
import {
  FREE_PERIOD_DAYS,
  microCentsToCredits,
  PLANS,
  PlanKey,
} from '@lib/creditPricing';
import { getUsageContext } from '@lib/usageContext';
import { bumpCreditDebitExhausted } from '@lib/metrics';
import { monetizationLog } from '@lib/loggers';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Typed errors ─────────────────────────────────────────────

// Carries `statusCode` + `errorCode` + `meta` in the shape `errorMiddleware`
// expects — the response body will include `{ message, errorCode, meta, … }`.

export class InsufficientCreditsError extends Error {
  statusCode = 402;
  errorCode = 'INSUFFICIENT_CREDITS' as const;
  meta: { need: number; have: number };
  constructor({ need, have }: { need: number; have: number }) {
    super('Insufficient credits');
    this.meta = { need, have };
  }
}

// Per-user concurrency cap. Distinct from `INSUFFICIENT_CREDITS` because the
// user isn't out of money — they're hammering the submit button (or scripting).
// 409 CONFLICT reads as "the state can't accept this now"; a future slot-free
// retry will succeed without any user action.
export class MaxConcurrentJobsError extends Error {
  statusCode = 409;
  errorCode = 'TOO_MANY_ACTIVE_JOBS' as const;
  meta: { active: number; limit: number };
  constructor({ active, limit }: { active: number; limit: number }) {
    super(`Too many active jobs (${active}/${limit}). Wait for one to finish before starting another.`);
    this.meta = { active, limit };
  }
}

// ── Balance & lazy reset ─────────────────────────────────────

export interface CreditBalance {
  allowance: number;
  bonus: number;
  total: number;
  periodStart: Date;
  periodEnd: Date;
  plan: PlanKey;
}

/**
 * Read current balances, applying a lazy period reset if the free-tier window
 * has expired. Paid plans are reset by Stripe webhooks — we only lazy-reset
 * free-plan users here.
 *
 * Lazy reset writes a ledger `period_reset` row and bumps the period forward.
 * Safe to call concurrently: the conditional update keys on the expiring
 * periodEnd so a second caller hitting the same boundary becomes a no-op.
 */
export const getBalance = async (userId: string | mongoose.Types.ObjectId): Promise<CreditBalance> => {
  const user = await UserModel.findById(userId).select('subscription credits').lean();
  if (!user) throw new Error('User not found');

  const now = new Date();
  const periodExpired = user.subscription.plan === 'free' && now >= user.credits.periodEnd;

  if (periodExpired) {
    await applyFreePeriodReset({ userId: user._id, priorPeriodEnd: user.credits.periodEnd });
    const refreshed = await UserModel.findById(userId).select('subscription credits').lean();
    if (refreshed) {
      return buildBalance(refreshed);
    }
  }

  return buildBalance(user);
};

const buildBalance = (user: {
  subscription: { plan: PlanKey };
  credits: { allowanceBalance: number; bonusBalance: number; periodStart: Date; periodEnd: Date };
}): CreditBalance => ({
  allowance: user.credits.allowanceBalance,
  bonus: user.credits.bonusBalance,
  total: user.credits.allowanceBalance + user.credits.bonusBalance,
  periodStart: user.credits.periodStart,
  periodEnd: user.credits.periodEnd,
  plan: user.subscription.plan,
});

const applyFreePeriodReset = async ({
  userId,
  priorPeriodEnd,
}: {
  userId: mongoose.Types.ObjectId | string;
  priorPeriodEnd: Date;
}): Promise<void> => {
  const user = await UserModel.findOne({ _id: userId }).select('subscription credits').lean();
  if (!user) return;
  if (user.subscription.plan !== 'free') return;

  const plan = PLANS[user.subscription.plan];
  const now = new Date();
  const periodStart = now;
  const periodEnd = new Date(now.getTime() + FREE_PERIOD_DAYS * MILLIS_PER_DAY);

  const oldAllowance = user.credits.allowanceBalance;
  const oldBonus = user.credits.bonusBalance;

  // Conditional on the exact expiring periodEnd: if another concurrent caller
  // already reset the period, this update no-ops (modifiedCount=0) and the
  // ledger insert below is skipped. Prevents double-grants on racing writes.
  const result = await UserModel.updateOne(
    { _id: userId, 'credits.periodEnd': priorPeriodEnd },
    {
      $set: {
        'credits.allowanceBalance': plan.monthlyAllowance,
        'credits.allowanceGranted': plan.monthlyAllowance,
        'credits.periodStart': periodStart,
        'credits.periodEnd': periodEnd,
      },
    },
  );

  if (result.modifiedCount === 0) return;

  const delta = plan.monthlyAllowance - oldAllowance;
  await CreditLedgerModel.create({
    userId,
    timestamp: now,
    delta,
    allowanceDelta: delta,
    bonusDelta: 0,
    balanceBefore: oldAllowance,
    balanceAfter: plan.monthlyAllowance,
    bonusBefore: oldBonus,
    bonusAfter: oldBonus,
    reason: 'period_reset',
    notes: 'free-tier 30-day rollover',
  });

  emitCreditsUpdated({
    userId,
    payload: {
      allowance: plan.monthlyAllowance,
      bonus: oldBonus,
      total: plan.monthlyAllowance + oldBonus,
      delta,
      reason: 'period_reset',
    },
  });

  monetizationLog.info(
    `Free period reset: user=${String(userId)} allowance=${oldAllowance}→${plan.monthlyAllowance} next=${periodEnd.toISOString()}`,
  );
};

// ── Debit real spend on job completion ────────────────────────

const MAX_DEBIT_RETRIES = 3;

/**
 * Charge the user for real provider spend accumulated during a job.
 *
 * Reads the running cost from the ambient `usageContext` (every `recordUsage`
 * call during the job has been summing into it), converts microcents →
 * credits via the central `microCentsToCredits` ratio, and atomically debits
 * the user's balance — allowance first, then bonus — writing a single
 * `debit_action` ledger row.
 *
 * Clamping policy: if actual spend exceeds what the user had, we debit
 * only what they actually have and eat the rest. This matches the
 * "balance ≥ 1 credit = go-ahead" gate: once the job is running we're
 * committed, and a slight overshoot on the user's last credit is a
 * bounded loss not worth mid-job abort or overdraft accounting.
 *
 * Called exclusively on the SUCCESS path. Failed / canceled jobs never
 * invoke this — provider cost incurred before a failure is written off
 * (consistent with the old "full refund on failure" behavior).
 */
export const debitActualSpend = async ({
  userId,
  jobId,
  jobType,
}: {
  userId: string | mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  jobType: string;
}): Promise<void> => {
  const ctx = getUsageContext();
  // No context == no job scope == no accumulator. Caller shouldn't invoke
  // this without a surrounding `runWithUsageContext`; bail silently if they
  // do rather than charging 0 and writing a misleading ledger row.
  if (!ctx) return;

  const microCents = ctx.spendMicroCents.current;
  const credits = microCentsToCredits(microCents);
  if (credits <= 0) return; // the job finished without any paid API calls

  // Retry loop: compare-and-swap can lose against a concurrent writer on
  // the same user (e.g. two parallel jobs finishing at the same tick). Up
  // to 3 retries with a fresh balance read each time. Realistically this
  // rarely matters — a single user's jobs serialize through their browser.
  for (let attempt = 0; attempt < MAX_DEBIT_RETRIES; attempt++) {
    const balance = await getBalance(userId);

    // If user already has 0 (raced to 0 via another debit), nothing to
    // do — we eat this job's spend.
    if (balance.total === 0) return;

    // Debit allowance first, then bonus. Clamp at what the user has.
    const allowanceDebit = Math.min(credits, balance.allowance);
    const bonusDebit = Math.min(credits - allowanceDebit, balance.bonus);
    const totalDebit = allowanceDebit + bonusDebit;
    if (totalDebit === 0) return;

    const result = await UserModel.updateOne(
      {
        _id: userId,
        'credits.allowanceBalance': { $gte: allowanceDebit },
        'credits.bonusBalance': { $gte: bonusDebit },
      },
      {
        $inc: {
          'credits.allowanceBalance': -allowanceDebit,
          'credits.bonusBalance': -bonusDebit,
        },
      },
    );

    if (result.modifiedCount === 1) {
      const newAllowance = balance.allowance - allowanceDebit;
      const newBonus = balance.bonus - bonusDebit;

      await CreditLedgerModel.create({
        userId,
        timestamp: new Date(),
        delta: -totalDebit,
        allowanceDelta: -allowanceDebit,
        bonusDelta: -bonusDebit,
        balanceBefore: balance.allowance,
        balanceAfter: newAllowance,
        bonusBefore: balance.bonus,
        bonusAfter: newBonus,
        reason: 'debit_action',
        actionType: jobType,
        jobId,
        notes: `Real cost: ${microCents} μ¢`,
      });

      emitCreditsUpdated({
        userId,
        payload: {
          allowance: newAllowance,
          bonus: newBonus,
          total: newAllowance + newBonus,
          delta: -totalDebit,
          reason: 'debit_action',
          actionType: jobType,
        },
      });

      const clamped = totalDebit < credits
        ? ` (clamped from ${credits} — ${credits - totalDebit} absorbed)`
        : '';
      monetizationLog.info(
        `Debited: user=${String(userId)} job=${jobType} credits=−${totalDebit} (allowance=−${allowanceDebit} bonus=−${bonusDebit}) spent=${microCents}μ¢${clamped} balance=${newAllowance + newBonus}`,
      );

      return;
    }
    // Race: retry with a fresh read.
  }
  // All retries lost — rare. Skip the debit (user gets free work this time)
  // rather than half-apply the debit with inconsistent accounting. The
  // UsageEvent row still captures the real spend for analytics.
  //
  // Escalate to Sentry + bump the `credit_debit_exhausted_total` metric so
  // a climbing rate is visible in dashboards — at a certain volume this
  // stops being bounded-loss and starts being a reconciliation problem.
  monetizationLog.warn(
    `Debit retries exhausted: user=${String(userId)} job=${String(jobId)} type=${jobType} spent=${microCents}μ¢ — user got free work`,
  );
  bumpCreditDebitExhausted();
  Sentry.captureMessage('debitActualSpend exhausted retries', {
    level: 'warning',
    tags: { area: 'credits.debit', jobType },
    extra: { userId: String(userId), jobId: String(jobId), microCents },
  });
};
