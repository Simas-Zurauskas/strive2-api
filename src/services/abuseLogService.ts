import mongoose from 'mongoose';
import AbuseLogModel, { ABUSE_LOG_RETENTION_DAYS } from '@models/AbuseLogModel';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { hashCanonicalEmail } from '@lib/emailHash';
import { onboardingAllowanceCredits } from '@lib/pricingConfig';
import { bgError } from '@lib/bg';

/**
 * Decide what free-tier allowance a brand-new signup deserves based on the
 * abuse log. If this canonical email was seen + deleted within the retention
 * window, the new account is created with zero credits (UX option "a":
 * silent, no credits, upgrade prompts on first generation attempt).
 *
 * Callers stamp the returned values onto the `User.credits` subdoc at create
 * time. When no abuse-log entry matches, returns the ONE-TIME onboarding grant
 * (KNOB 9), which the first free-period reset collapses to the monthly allowance.
 */
export const resolveSignupAllowance = async (email: string): Promise<{
  allowanceBalance: number;
  allowanceGranted: number;
  blocked: boolean;
}> => {
  try {
    const emailHash = hashCanonicalEmail(email);
    const existing = await AbuseLogModel.findOne({ emailHash }).select('_id').lean();
    if (existing) {
      return { allowanceBalance: 0, allowanceGranted: 0, blocked: true };
    }
  } catch (err) {
    // Lookup failure must not break signup. Fall through to the normal grant.
    bgError('abuseLog.resolveSignupAllowance')(err);
  }

  // ONE-TIME onboarding grant (KNOB 9), not the recurring monthly allowance.
  // `applyFreePeriodReset` resets to the plan's monthlyAllowance at the first
  // 30-day rollover, so this decays to the steady state on its own — there is
  // deliberately no "has claimed" flag to keep in sync.
  const onboardingGrant = onboardingAllowanceCredits();
  return { allowanceBalance: onboardingGrant, allowanceGranted: onboardingGrant, blocked: false };
};

/**
 * Upsert an abuse-log row on account deletion. Idempotent: re-running the
 * same hash bumps counters and pushes the retention window forward.
 *
 * Sums lifetime credit movement from CreditLedgerModel under the deleting
 * user's id so the log captures the cost of the abuse even though no PII
 * is retained.
 */
export const recordAccountDeletion = async ({
  email,
  userId,
}: {
  email: string;
  userId: mongoose.Types.ObjectId | string;
}): Promise<void> => {
  const emailHash = hashCanonicalEmail(email);

  const [granted, consumed] = await Promise.all([
    CreditLedgerModel.aggregate<{ total: number }>([
      { $match: { userId: new mongoose.Types.ObjectId(userId), delta: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$delta' } } },
    ]),
    CreditLedgerModel.aggregate<{ total: number }>([
      { $match: { userId: new mongoose.Types.ObjectId(userId), delta: { $lt: 0 } } },
      { $group: { _id: null, total: { $sum: '$delta' } } },
    ]),
  ]);

  const lifetimeGranted = granted[0]?.total ?? 0;
  const lifetimeConsumed = Math.abs(consumed[0]?.total ?? 0);

  const now = new Date();
  const retentionUntil = new Date(now.getTime() + ABUSE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  await AbuseLogModel.updateOne(
    { emailHash },
    {
      $setOnInsert: { firstSeenAt: now },
      $set: { lastSignupAt: now, retentionUntil },
      $inc: {
        signupCount: 1,
        lifetimeCreditsGranted: lifetimeGranted,
        lifetimeCreditsConsumed: lifetimeConsumed,
      },
    },
    { upsert: true },
  );
};
