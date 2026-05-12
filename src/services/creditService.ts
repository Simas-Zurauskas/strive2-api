import mongoose from 'mongoose';
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
import { captureWarning } from '@lib/errorReporter';
import { withCreditTransaction } from '@lib/dbTransaction';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

// User-visible .message uses "allowance" — credits are internal. errorCode
// + class name stay historical for log continuity.
export class InsufficientCreditsError extends Error {
  statusCode = 402;
  errorCode = 'INSUFFICIENT_CREDITS' as const;
  meta: { need: number; have: number };
  constructor({ need, have }: { need: number; have: number }) {
    super('Your monthly allowance is used up. Top up or upgrade to keep going.');
    this.meta = { need, have };
  }
}

// 409 not 402: a slot-free retry will succeed without user action.
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

// Lazy-resets free-plan users at period boundary; paid plans reset via Stripe
// webhook. Conditional update on periodEnd makes concurrent calls a no-op.
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

// Snapshots the bucket markup for the duration of a scope. If allowance
// runs out mid-scope the remaining spend stays at the snapshot rate; debit
// clamp absorbs the bounded overflow. Re-deciding per call would require
// per-call vendor cost in the accumulator — not worth the invasiveness.
// Failure → 'allowance' so an error under-charges rather than over-charges.
export const determineCreditBucket = async (
  userId: string | mongoose.Types.ObjectId,
): Promise<'allowance' | 'bonus'> => {
  try {
    const balance = await getBalance(userId);
    return balance.allowance > 0 ? 'allowance' : 'bonus';
  } catch {
    return 'allowance';
  }
};

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

  // Update conditional on expiring periodEnd → second caller no-ops, no
  // double-grant. Transaction makes $set + ledger insert atomic so a crash
  // can't leave a fresh allowance without an audit row.
  const delta = plan.monthlyAllowance - oldAllowance;
  const applied = await withCreditTransaction(async (session) => {
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
      { session: session ?? undefined },
    );

    if (result.modifiedCount === 0) return false;

    await CreditLedgerModel.create(
      [
        {
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
        },
      ],
      { session: session ?? undefined },
    );
    return true;
  });

  if (!applied) return;

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

// Retries + jittered backoff (5–320ms exp w/ cap) absorb CAS loss under
// bursty concurrency. bumpCreditDebitExhausted + Sentry warn monitor the
// residual rate when retries run out.
const MAX_DEBIT_RETRIES = 10;
const debitBackoffMs = (attempt: number): number => {
  const base = Math.min(320, 5 * 2 ** attempt);
  return Math.floor(base * (0.5 + Math.random() * 0.5));
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Charges the user for real provider spend accumulated in usageContext.
// Debits allowance first, then bonus; if spend > balance we clamp and eat
// the rest (the "≥1 credit go-ahead" gate accepts bounded overshoot on the
// last credit). minMicroCents forgives near-zero chat-stream disconnects.
export const debitActualSpend = async ({
  userId,
  jobId,
  jobType,
  minMicroCents = 0,
}: {
  userId: string | mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  jobType: string;
  minMicroCents?: number;
}): Promise<void> => {
  const ctx = getUsageContext();
  if (!ctx) return; // No surrounding runWithUsageContext → no accumulator.

  const microCents = ctx.spendMicroCents.current;
  if (microCents < minMicroCents) {
    monetizationLog.info(
      `Debit forgiven: user=${String(userId)} job=${jobType} spent=${microCents}μ¢ < threshold ${minMicroCents}μ¢`,
    );
    return;
  }
  const credits = microCentsToCredits(microCents);
  if (credits <= 0) return;

  // CAS retry loop: a concurrent debit on the same user can lose the swap.
  // Refresh balance each attempt; see MAX_DEBIT_RETRIES + debitBackoffMs.
  for (let attempt = 0; attempt < MAX_DEBIT_RETRIES; attempt++) {
    const balance = await getBalance(userId);
    if (balance.total === 0) return;

    const allowanceDebit = Math.min(credits, balance.allowance);
    const bonusDebit = Math.min(credits - allowanceDebit, balance.bonus);
    const totalDebit = allowanceDebit + bonusDebit;
    if (totalDebit === 0) return;

    // Transaction: $gte CAS filter + ledger insert commit atomically; a crash
    // between them would otherwise leave a debit without an audit row.
    let didDebit = false;
    let newAllowance = 0;
    let newBonus = 0;
    await withCreditTransaction(async (session) => {
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
        { session: session ?? undefined },
      );

      if (result.modifiedCount !== 1) return;

      newAllowance = balance.allowance - allowanceDebit;
      newBonus = balance.bonus - bonusDebit;

      await CreditLedgerModel.create(
        [
          {
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
          },
        ],
        { session: session ?? undefined },
      );
      didDebit = true;
    });

    if (didDebit) {
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
    if (attempt < MAX_DEBIT_RETRIES - 1) await sleep(debitBackoffMs(attempt));
  }
  // All retries lost. Skip rather than half-apply with inconsistent
  // accounting — UsageEvent still records the spend. A climbing
  // credit_debit_exhausted_total metric escalates from bounded-loss to
  // a reconciliation problem.
  monetizationLog.warn(
    `Debit retries exhausted: user=${String(userId)} job=${String(jobId)} type=${jobType} spent=${microCents}μ¢ — user got free work`,
  );
  bumpCreditDebitExhausted();
  captureWarning('debitActualSpend exhausted retries', {
    tags: { area: 'credits.debit', job_type: jobType },
    extra: { userId: String(userId), jobId: String(jobId), microCents },
    fingerprint: ['credits.debit', 'exhausted-retries', jobType],
  });
};
