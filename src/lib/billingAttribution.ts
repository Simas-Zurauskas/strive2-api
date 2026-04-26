/**
 * Per-event allowance/top-up attribution math for the engineer billing view.
 *
 * `UsageEvent` rows are fine-grained (one row per external API call) but the
 * actual credit debit happens once per JOB — see `creditService.debitActualSpend`
 * which sums every event's `chargedMicroCents` and writes a single
 * `CreditLedger` `debit_action` row carrying `allowanceDelta` + `bonusDelta`.
 *
 * To show per-event "you paid $X" in the engineer view we pro-rate the job's
 * debit back onto each event by its share of the job's total chargedMicroCents.
 * Pro-rating drifts slightly from a per-event `Math.ceil(...)` but rows in the
 * same job sum back to the actual ledger debit.
 */
import { PLAN_USD_PER_CREDIT, TOPUP_USD_PER_CREDIT, PlanKey } from './creditPricing';

export interface AttributionLedgerInput {
  /** Negative deltas in the ledger; this helper expects |allowance| / |bonus|. */
  allowanceDelta: number;
  bonusDelta: number;
}

export interface EventAttribution {
  /** Pro-rated credits (decimal) charged from the user's monthly allowance. */
  creditsAllowance: number;
  /** Pro-rated credits (decimal) charged from top-up bonus balance. */
  creditsBonus: number;
  /**
   * The dominant balance source. `null` when the row has no matching debit
   * (job in flight or failed) or the job's total chargedMicroCents was zero
   * — both edge cases render as `—` in the UI.
   */
  source: 'allowance' | 'topup' | 'mixed' | null;
  /**
   * The dollars the user effectively paid for this row (allowance × plan rate
   * + bonus × top-up rate). `null` when no debit is available to attribute.
   */
  userPaidUsd: number | null;
}

const NO_ATTRIBUTION: EventAttribution = {
  creditsAllowance: 0,
  creditsBonus: 0,
  source: null,
  userPaidUsd: null,
};

export const attributeEvent = ({
  eventChargedMicroCents,
  jobTotalChargedMicroCents,
  ledger,
  planAtTime,
}: {
  eventChargedMicroCents: number;
  jobTotalChargedMicroCents: number;
  ledger: AttributionLedgerInput | null;
  planAtTime: PlanKey | null | undefined;
}): EventAttribution => {
  if (!ledger) return NO_ATTRIBUTION;
  if (!Number.isFinite(jobTotalChargedMicroCents) || jobTotalChargedMicroCents <= 0) {
    return NO_ATTRIBUTION;
  }
  if (!Number.isFinite(eventChargedMicroCents) || eventChargedMicroCents <= 0) {
    return NO_ATTRIBUTION;
  }

  const share = eventChargedMicroCents / jobTotalChargedMicroCents;
  const allowanceCredits = Math.abs(ledger.allowanceDelta);
  const bonusCredits = Math.abs(ledger.bonusDelta);

  // Free-tier clamp: balance was 0 so the debit absorbed nothing. Surface a
  // zero-cost row tied to the user's plan (Free) instead of "Mixed", which
  // would imply both pools fired.
  if (allowanceCredits === 0 && bonusCredits === 0) {
    return {
      creditsAllowance: 0,
      creditsBonus: 0,
      source: 'allowance',
      userPaidUsd: 0,
    };
  }

  const creditsAllowance = share * allowanceCredits;
  const creditsBonus = share * bonusCredits;

  const planRate = planAtTime ? PLAN_USD_PER_CREDIT[planAtTime] : 0;
  const userPaidUsd = creditsAllowance * planRate + creditsBonus * TOPUP_USD_PER_CREDIT;

  let source: EventAttribution['source'];
  if (allowanceCredits > 0 && bonusCredits === 0) source = 'allowance';
  else if (bonusCredits > 0 && allowanceCredits === 0) source = 'topup';
  else source = 'mixed';

  return { creditsAllowance, creditsBonus, source, userPaidUsd };
};
