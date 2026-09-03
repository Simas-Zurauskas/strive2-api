import { Request, Response, NextFunction } from 'express';
import asyncHandler from 'express-async-handler';
import { InsufficientCreditsError, getBalance } from '@services/creditService';
import { recordCreditRefusal } from '@services/creditRefusalService';
import { CREDIT_REFUSAL_PATH_MAX } from '@models/CreditRefusalModel';
import { monetizationLog } from '@lib/loggers';

/**
 * Gate for credit-metered endpoints. The user may start ANY action as long
 * as they have ≥ 1 credit in their balance. Real cost is debited after the
 * action completes (see `debitActualSpend` in creditService) — once the
 * job is running we're committed, and a slight over-spend on the user's
 * last credit is a bounded loss not worth mid-job abort logic.
 */
export const requireCredits = () => asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const userId = req.userId;
  if (!userId) {
    // Should never happen — `protect` runs first and stamps `req.userId`.
    // Guard rail so a misordered middleware chain surfaces as an auth error
    // instead of crashing here with "Cannot read .findById of undefined".
    const err = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    throw err;
  }

  const balance = await getBalance(userId);
  if (balance.total < 1) {
    monetizationLog.info(
      `Credit gate blocked: user=${userId} balance=${balance.total} path=${req.method} ${req.originalUrl}`,
    );
    // Durable counterpart to the log line above. A refusal is the only clean
    // revealed-demand signal we have — the user actively asked for more work
    // and was blocked — and until now it existed solely on stdout, so it had
    // never been counted. Fire-and-forget: `recordCreditRefusal` swallows its
    // own errors, so this cannot delay or fail the 402 below.
    // `originalUrl` is attacker-influenced, so it is bounded here as well as
    // in the service before it is ever stored.
    try {
      recordCreditRefusal({
        userId,
        plan: balance.plan,
        path: `${req.method} ${req.originalUrl}`.slice(0, CREDIT_REFUSAL_PATH_MAX),
        need: 1,
        have: balance.total,
      });
    } catch {
      // Defence in depth. `recordCreditRefusal` already guarantees it never
      // throws, but this gate's contract — a 402 reaches the client, always —
      // must not depend on a collaborator keeping its promise. Swallowed
      // silently here because the service has already logged and reported.
    }
    throw new InsufficientCreditsError({ need: 1, have: balance.total });
  }

  next();
});
