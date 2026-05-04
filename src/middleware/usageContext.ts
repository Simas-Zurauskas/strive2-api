import { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';
import { runWithUsageContext } from '@lib/usageContext';
import UserModel from '@models/UserModel';
import { bgError } from '@lib/bg';

/**
 * Enter an AsyncLocalStorage scope stamped with the authenticated user for
 * the duration of this request. Paid actions triggered inline in the request
 * path (course clarify, chat stream, recall grading, code execution) read
 * from it via `getUsageContext()` and attribute their cost back to the user.
 *
 * Must be mounted AFTER `protect` so `req.userId` is populated; requests
 * that haven't passed auth yet (signup, signin, health probes) skip the
 * scope entirely and any accidental paid action in those paths produces an
 * untagged (no-op) `recordUsage` call — safer than attributing to the wrong
 * user.
 *
 * Loads the user's plan + subscription status once per request and stamps
 * them on the scope so every UsageEvent recorded under it carries the plan
 * snapshot. A failed lookup falls through to a stamp-less scope — unattributed
 * events are honest about the missing context.
 */
export const usageContextMiddleware = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    next();
    return;
  }
  const user = await UserModel.findById(userId, { 'subscription.plan': 1, 'subscription.status': 1 })
    .lean()
    .catch((e) => {
      bgError('usageContextMiddleware.userLookup')(e);
      return null;
    });

  // Refine the Sentry scope with plan/subscription tags so any downstream
  // capture in this request can be sliced by tier. The user id was already
  // tagged by `protect` (or `optionalProtect`) — these tags layer on top.
  // Wrapped in try/catch so a misconfigured Sentry can never block a
  // legitimate request from proceeding.
  try {
    const scope = Sentry.getCurrentScope();
    if (user?.subscription?.plan) scope.setTag('plan', user.subscription.plan);
    if (user?.subscription?.status) scope.setTag('subscription_status', user.subscription.status);
  } catch {
    // ignored
  }

  runWithUsageContext({
    ctx: {
      userId,
      source: 'request',
      ...(user?.subscription?.plan ? { plan: user.subscription.plan } : {}),
      ...(user?.subscription?.status ? { subscriptionStatus: user.subscription.status } : {}),
    },
    fn: () => {
      next();
    },
  });
};
