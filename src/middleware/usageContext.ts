import { Request, Response, NextFunction } from 'express';
import { runWithUsageContext } from '@lib/usageContext';

/**
 * Enter an AsyncLocalStorage scope stamped with the authenticated user for
 * the duration of this request. Paid actions triggered inline in the request
 * path (course clarify, chat stream, insight grading, code execution) read
 * from it via `getUsageContext()` and attribute their cost back to the user.
 *
 * Must be mounted AFTER `protect` so `req.userId` is populated; requests
 * that haven't passed auth yet (signup, signin, health probes) skip the
 * scope entirely and any accidental paid action in those paths produces an
 * untagged (no-op) `recordUsage` call — safer than attributing to the wrong
 * user.
 */
export const usageContextMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  const userId = req.userId;
  if (!userId) {
    next();
    return;
  }
  runWithUsageContext({
    ctx: { userId, source: 'request' },
    fn: () => {
      next();
    },
  });
};
