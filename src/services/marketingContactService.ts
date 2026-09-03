import mongoose from 'mongoose';
import MarketingContactModel from '@models/MarketingContactModel';
import { MARKETING_EVIDENCE } from '@lib/constants';
import { bgError } from '@lib/bg';

/**
 * Enrol a verified address in the promotional audience.
 *
 * Extracted from `verifyEmail.ts`, which was the ONLY place this ran. Google
 * OAuth signups set `emailVerified: true` directly and never pass through it,
 * so every Google user was created outside the promotional audience — 20 of
 * the 26 most recent signups at the time this was written, widening by roughly
 * 20/month. That is an asset-preservation and consent-record bug independent
 * of whether any campaign is ever sent.
 *
 * Two properties this function must never lose:
 *
 *   1. **`$setOnInsert` only.** If a row already exists it is left exactly as
 *      it is, so a returning address that previously opted out is NOT
 *      resurrected. Nothing here touches Mailjet, so `addforce` — the action
 *      that clears an unsubscribe flag — is unreachable from this path.
 *   2. **Best-effort.** A ledger blip must never fail the caller. Both call
 *      sites are on a user's route into the product (email verification, and
 *      Google sign-in); neither may 500 because a marketing row did not write.
 *
 * The filter is keyed on `email`, matching the collection's uniqueness, so a
 * concurrent double-signup upserts once rather than racing two inserts.
 */
export const enrolVerifiedContact = async (params: {
  userId: mongoose.Types.ObjectId | string;
  email: string;
}): Promise<void> => {
  try {
    await MarketingContactModel.updateOne(
      { email: params.email },
      {
        $setOnInsert: {
          userId: new mongoose.Types.ObjectId(String(params.userId)),
          email: params.email,
          basis: 'soft_opt_in',
          source: 'signup',
          evidence: MARKETING_EVIDENCE.SIGNUP_NOTICE,
          optedOut: false,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    bgError('marketingContact.enrolVerifiedContact')(err);
  }
};
