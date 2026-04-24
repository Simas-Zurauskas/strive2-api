import { Request, Response, NextFunction } from 'express';
import asyncHandler from 'express-async-handler';
import { InsufficientCreditsError, getBalance } from '@services/creditService';
import { monetization } from '@lib/loggers';

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
    monetization.info(
      `Credit gate blocked: user=${userId} balance=${balance.total} path=${req.method} ${req.originalUrl}`,
    );
    throw new InsufficientCreditsError({ need: 1, have: balance.total });
  }

  next();
});
