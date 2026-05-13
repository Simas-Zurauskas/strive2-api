import mongoose from 'mongoose';
import SignupCreditGrantModel from '@models/SignupCreditGrantModel';
import UserModel from '@models/UserModel';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { emitCreditsUpdated } from '@lib/creditSocket';
import { withCreditTransaction } from '@lib/dbTransaction';
import { monetizationLog } from '@lib/loggers';
import { captureError } from '@lib/errorReporter';
import { PRICING_CONFIG } from '@lib/pricingConfig';

// Pre-provisioned signup credits (typically from the old-user relaunch
// campaign). One claim per email — the consumedAt CAS is what makes a
// second signup with the same email a no-op.

const TOPUP_CREDITS_PER_USD = PRICING_CONFIG.topup.creditsPerUsd;

export const awardSignupGrantIfAny = async (params: {
  userId: mongoose.Types.ObjectId | string;
  email: string;
}): Promise<{ awarded: boolean; usdAmount?: number; credits?: number }> => {
  const email = params.email.toLowerCase().trim();

  // CAS-claim the grant: only the first signup wins. If `consumedAt` was
  // already set, `findOneAndUpdate` returns null and we silently return —
  // the user still signed up successfully, they just didn't get the grant.
  const claim = await SignupCreditGrantModel.findOneAndUpdate(
    { email, consumedAt: { $exists: false } },
    {
      $set: {
        consumedAt: new Date(),
        consumedByUserId: new mongoose.Types.ObjectId(String(params.userId)),
      },
    },
    { returnDocument: 'after' },
  ).lean();

  if (!claim) return { awarded: false };

  const credits = Math.floor(claim.usdAmount * TOPUP_CREDITS_PER_USD);
  if (credits <= 0) {
    monetizationLog.warn(
      `signup-grant: claim with zero/negative credits email=${email} usd=${claim.usdAmount}`,
    );
    return { awarded: false };
  }

  // Mirror the stripe top-up flow: $inc + ledger insert run inside one
  // transaction so a write failure doesn't leave a $inc applied without
  // an audit row. The grant claim above is outside the transaction by
  // design — releasing it back on rollback would re-open the race; we'd
  // rather lose a single grant to a transient DB blip than double-grant.
  try {
    let newBonus = 0;
    let userBalance = { allowance: 0, bonus: 0 };

    await withCreditTransaction(async (session) => {
      const user = await UserModel.findById(params.userId)
        .select('credits')
        .session(session ?? null)
        .lean();
      if (!user) throw new Error('user-not-found');

      userBalance = {
        allowance: user.credits.allowanceBalance,
        bonus: user.credits.bonusBalance,
      };

      await UserModel.updateOne(
        { _id: params.userId },
        { $inc: { 'credits.bonusBalance': credits } },
        session ? { session } : undefined,
      );

      newBonus = userBalance.bonus + credits;

      await CreditLedgerModel.create(
        [
          {
            userId: params.userId,
            timestamp: new Date(),
            delta: credits,
            allowanceDelta: 0,
            bonusDelta: credits,
            balanceBefore: userBalance.allowance,
            balanceAfter: userBalance.allowance,
            bonusBefore: userBalance.bonus,
            bonusAfter: newBonus,
            reason: 'admin_grant',
            notes: `Signup grant: $${claim.usdAmount}${claim.reason ? ` (${claim.reason})` : ''}`,
          },
        ],
        session ? { session } : undefined,
      );
    });

    emitCreditsUpdated({
      userId: params.userId,
      payload: {
        allowance: userBalance.allowance,
        bonus: newBonus,
        total: userBalance.allowance + newBonus,
        delta: credits,
        reason: 'admin_grant',
      },
    });

    monetizationLog.info(
      `signup-grant: awarded user=${String(params.userId)} email=${email} usd=$${claim.usdAmount} credits=+${credits}`,
    );

    return { awarded: true, usdAmount: claim.usdAmount, credits };
  } catch (err) {
    // The grant is already marked consumed but the $inc + ledger rolled
    // back. Surface to Sentry — ops will need to re-grant manually rather
    // than leave the user short. Don't throw: signup must still complete.
    captureError(err, {
      level: 'error',
      tags: { area: 'signup_grant.apply' },
      extra: { email, userId: String(params.userId), usdAmount: claim.usdAmount },
      fingerprint: ['signup_grant', 'apply_failed'],
    });
    monetizationLog.error(
      `signup-grant: APPLY FAILED user=${String(params.userId)} email=${email} usd=$${claim.usdAmount} — grant marked consumed but credits NOT awarded`,
    );
    return { awarded: false };
  }
};
