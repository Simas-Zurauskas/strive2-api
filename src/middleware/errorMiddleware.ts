import { ENVIRONMENT } from '@conf/env';
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { lifecycleLog } from '@lib/loggers';
import { captureError } from '@lib/errorReporter';

export const ERROR_CODES = [
  'CUSTOM_ERROR',
  'NOT_FOUND',
  'EMAIL_NOT_VERIFIED',
  'EMAIL_ALREADY_VERIFIED',
  'EMAIL_VERIFICATION_EXPIRED',
  'EMAIL_VERIFICATION_INVALID',
  'VERIFICATION_RESEND_TOO_SOON',
  'PASSWORD_RESET_INVALID',
  'PASSWORD_RESET_EXPIRED',
  'PASSWORD_ALREADY_SET',
  'PASSWORD_NOT_SET',
  'INSUFFICIENT_CREDITS',
  'SUBSCRIPTION_ALREADY_EXISTS',
  'TOO_MANY_ACTIVE_JOBS',
  // Email-OTP confirmation flow (changePassword, deleteAccount).
  'CODE_REQUEST_TOO_SOON',
  'CODE_REQUEST_RATE_EXCEEDED',
  'SECURITY_CODE_INVALID',
  'SECURITY_CODE_EXPIRED',
  'SECURITY_CODE_TOO_MANY_ATTEMPTS',
  // Sliding-refresh: returned when the bearer token presented to /refresh
  // is no longer valid (user deleted, tokenVersion bumped, etc.). Distinct
  // from a generic 401 so the client can branch (force re-login).
  'SESSION_INVALID',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface IError {
  message?: string;
  status?: number;
  /** Explicit HTTP status set on the error itself (honored when the controller did not call `res.status()`). */
  statusCode?: number;
  stack?: string;
  errorCode?: ErrorCode;
  /**
   * Arbitrary structured data echoed to the client alongside the error body.
   * Used by credit errors to carry `need` / `have` / `limit` / `windowDescription`
   * so the client can render contextual "out of credits" or "rate-limited"
   * modals without string-parsing the message.
   */
  meta?: Record<string, unknown>;
}

/**
 * Lightweight error class that carries an optional `errorCode`.
 *
 * @example
 * res.status(400);
 * throw new AppError('Error', { errorCode: 'CUSTOM_ERROR' });
 */
export class AppError extends Error {
  errorCode?: ErrorCode;
  statusCode?: number;
  meta?: Record<string, unknown>;

  constructor(
    message: string,
    options?: { errorCode?: ErrorCode; statusCode?: number; meta?: Record<string, unknown> },
  ) {
    super(message);
    this.errorCode = options?.errorCode;
    this.statusCode = options?.statusCode;
    this.meta = options?.meta;
  }
}

export const errorHandler = async (err: IError, req: Request, res: Response, next: NextFunction) => {
  // Zod validation errors → 400 with the first issue message
  if (err instanceof ZodError) {
    const message = err.issues[0]?.message || 'Validation error';
    res.status(400).json({ message });
    return;
  }

  // Precedence: an explicit `res.status(4xx)` the controller set wins; next
  // we honor `err.statusCode` (used by `parseIndexParam` / `parseRecallCardIdParam`
  // and similar throw-with-code helpers); fallback is 500. Without the err
  // branch those validation throws silently escalated to 500s in logs.
  const errStatus = typeof err.statusCode === 'number' ? err.statusCode : undefined;
  const statusCode = res.statusCode >= 400 ? res.statusCode : errStatus ?? 500;
  const message = err.message || 'Something went wrong';
  const errorCode = (err as AppError).errorCode;

  const method = req.method;
  const url = req.originalUrl;
  const userAgent = req.get('User-Agent');
  const userId = req.userId || 'anonymous';
  // Correlation id from the requestId middleware — always set in practice,
  // but we defensively allow it to be missing so a misordered middleware
  // chain doesn't swallow the whole error handler.
  const requestIdVal = req.id ?? '-';

  lifecycleLog.error(
    `request:error ${statusCode} ${method} ${url} req=${requestIdVal} user=${userId} ` +
      `code=${errorCode ?? '-'} msg="${message}" ` +
      `ua="${userAgent?.substring(0, 100) ?? '-'}"` +
      (ENVIRONMENT !== 'production' && err.stack ? `\n${err.stack}` : ''),
  );

  // Only 5xx (server bugs / unexpected exceptions) reach Sentry. 4xx are
  // operational signals that the API surfaces to the client — Zod validation,
  // insufficient credits, unverified email, too many concurrent jobs — and
  // reporting them would burn the event quota and bury real signal.
  // `captureError` also gates on operational client errors as a defence in
  // depth in case `statusCode` is missing on the err itself.
  if (statusCode >= 500) {
    captureError(err, {
      tags: {
        http_status: statusCode,
        http_method: method,
        ...(errorCode ? { error_code: errorCode } : {}),
      },
      extra: {
        url,
        requestId: requestIdVal,
        userAgent: userAgent?.substring(0, 200),
      },
    });
  }

  res.status(statusCode).json({
    message,
    ...(errorCode && { errorCode }),
    ...(err.meta && { meta: err.meta }),
    // Echo the correlation id in the error body too — clients can quote it
    // verbatim in bug reports and we can grep logs for the same value.
    requestId: requestIdVal,
    stack: ENVIRONMENT === 'production' ? null : err.stack,
  });
};
