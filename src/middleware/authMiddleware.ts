import UserModel from '@models/UserModel';
import { Request, Response, NextFunction } from 'express';
import asyncHandler from 'express-async-handler';
import { decodeAuthToken } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';
import { AuthProvider } from '@lib/constants';

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
  next();
});

// Gates feature routes (course, gamification, insight, …) behind email
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
