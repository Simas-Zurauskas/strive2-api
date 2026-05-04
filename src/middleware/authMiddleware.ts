import UserModel from '@models/UserModel';
import { Request, Response, NextFunction } from 'express';
import asyncHandler from 'express-async-handler';
import { decodeAuthToken } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import { AuthProvider } from '@lib/constants';
import { setSentryUser } from '@lib/errorReporter';

export const protect = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.headers.authorization?.startsWith('Bearer')) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  const token = req.headers.authorization.split(' ')[1];
  const decoded = decodeAuthToken(token);

  if (!decoded?.id) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  const user = await UserModel.findById(decoded.id).select('tokenVersion').lean();

  if (!user || decoded.tokenVersion !== user.tokenVersion) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  req.userId = decoded.id;
  // Attach the user id to the Sentry scope so any downstream error
  // captured during this request can be filtered/grouped by user without
  // every callsite remembering to set it. `usageContext` middleware
  // refines this further with plan/subscription tags once it loads them.
  setSentryUser(decoded.id);
  next();
});

/**
 * Soft-auth: attach `req.userId` if a valid bearer token is present, but
 * never reject the request. Designed for surfaces that are public to
 * anonymous visitors AND benefit from per-user attribution when a session
 * exists — e.g. the product-KB chat (free for everyone, but rate-limit
 * + usage telemetry should bind to the user when one is signed in).
 *
 * Failures in any step (no header, malformed header, invalid token, missing
 * user, stale tokenVersion) all fall through silently to anonymous mode.
 * Errors loading the user are swallowed for the same reason: the worst
 * case is "treated as anonymous", never a 5xx on a public surface.
 */
export const optionalProtect = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      next();
      return;
    }
    const token = header.split(' ')[1];
    if (!token) {
      next();
      return;
    }
    const decoded = decodeAuthToken(token);
    if (!decoded?.id) {
      next();
      return;
    }
    try {
      const user = await UserModel.findById(decoded.id).select('tokenVersion').lean();
      if (user && decoded.tokenVersion === user.tokenVersion) {
        req.userId = decoded.id;
        setSentryUser(decoded.id);
      }
    } catch {
      // Stay anonymous on any DB error — public surfaces should never 5xx
      // because of an auth-attribution lookup.
    }
    next();
  },
);

/**
 * Final authorisation gate for engineer-only surfaces (usage events,
 * the dev "Reset quiz" endpoint, anything we add later that's strictly
 * for ops). Stack ordering: `protect → requireVerified → requireAdmin`,
 * because admin access is a stronger claim than verified-credentials.
 *
 * 403 (not 401): the user's session is valid, they just don't have
 * the role. 401 would trigger the client's auto-signOut interceptor —
 * an admin route hit by a non-admin should NOT log them out.
 */
export const requireAdmin = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const user = await UserModel.findById(req.userId).select('isAdmin').lean();

  if (!user) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  if (!user.isAdmin) {
    res.status(403);
    throw new AppError('Forbidden — admin access required.', { errorCode: 'CUSTOM_ERROR' });
  }

  next();
});

// Gates feature routes (course, gamification, recall, …) behind email
// verification for credential-based accounts. `protect` stays JWT-only so
// /me, /logout, /resend-verification-authenticated, /delete-account remain
// reachable for unverified users — otherwise the 401 interceptor on the
// client would sign them out before they can resend or verify.
//
// 403 (not 401) is deliberate: 401 triggers the client's sign-out path
// (api/client.ts); we want the unverified user to stay signed in and be
// redirected to /verify. The `EMAIL_NOT_VERIFIED` errorCode lets the
// client branch on the reason.
export const requireVerified = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const user = await UserModel.findById(req.userId).select('emailVerified authProviders').lean();

  if (!user) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  const hasCredentials = user.authProviders.some((p) => p.provider === AuthProvider.CREDENTIALS);
  if (hasCredentials && !user.emailVerified) {
    res.status(403);
    throw new AppError('Email not verified', { errorCode: 'EMAIL_NOT_VERIFIED' });
  }

  next();
});
