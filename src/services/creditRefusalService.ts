import mongoose from 'mongoose';
import CreditRefusalModel, { CREDIT_REFUSAL_PATH_MAX } from '@models/CreditRefusalModel';
import { bgError } from '@lib/bg';

/**
 * Record that a user was refused metered work for want of credits.
 *
 * Fire-and-forget by contract: this is a behavioural metric sitting on a
 * request-blocking path, so it must never delay the 402 and must never turn
 * one into a 500. Errors go to `bgError`, which logs and reports to Sentry
 * without rethrowing — the same treatment `emitCreditsUpdated` gets.
 *
 * `path` is truncated HERE rather than by a schema validator: the write is
 * error-swallowed, so a validator rejection would silently discard exactly
 * the longest and most anomalous URLs, which are the ones worth seeing.
 */
export const recordCreditRefusal = (params: {
  userId: string;
  plan: string;
  path: string;
  need: number;
  have: number;
}): void => {
  // The whole body is guarded, not just the promise. `.catch()` alone covers
  // only the async rejection — a SYNCHRONOUS throw (an invalid ObjectId, a
  // model accessed before mongoose is connected, a schema cast error raised
  // eagerly) would escape into the middleware and turn a 402 into a 500,
  // which is the precise failure this function exists to be incapable of.
  try {
    if (!mongoose.Types.ObjectId.isValid(params.userId)) {
      // Reported, not dropped. `protect` should make this unreachable, so if
      // it ever fires something upstream is wrong — and a function whose whole
      // contract is "never fail silently" must not have one branch that does.
      bgError('creditRefusal.record')(new Error(`invalid userId: ${params.userId}`));
      return;
    }

    void CreditRefusalModel.create({
      userId: new mongoose.Types.ObjectId(params.userId),
      plan: params.plan,
      path: params.path.slice(0, CREDIT_REFUSAL_PATH_MAX),
      need: params.need,
      have: params.have,
    }).catch(bgError('creditRefusal.record'));
  } catch (err) {
    bgError('creditRefusal.record')(err);
  }
};
