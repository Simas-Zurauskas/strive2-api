import { ENVIRONMENT } from '@conf/env';
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export const ERROR_CODES = [
  'CUSTOM_ERROR',
  'EMAIL_NOT_VERIFIED',
  'EMAIL_ALREADY_VERIFIED',
  'EMAIL_VERIFICATION_EXPIRED',
  'EMAIL_VERIFICATION_INVALID',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface IError {
  message?: string;
  status?: number;
  /** Explicit HTTP status set on the error itself (honored when the controller did not call `res.status()`). */
  statusCode?: number;
  stack?: string;
  errorCode?: ErrorCode;
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

  constructor(message: string, options?: { errorCode?: ErrorCode }) {
    super(message);
    this.errorCode = options?.errorCode;
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
  // we honor `err.statusCode` (used by `parseIndexParam` / `parseInsightIdParam`
  // and similar throw-with-code helpers); fallback is 500. Without the err
  // branch those validation throws silently escalated to 500s in logs.
  const errStatus = typeof err.statusCode === 'number' ? err.statusCode : undefined;
  const statusCode = res.statusCode >= 400 ? res.statusCode : errStatus ?? 500;
  const message = err.message || 'Something went wrong';
  const errorCode = (err as AppError).errorCode;

  // Essential error logging
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.originalUrl;
  const userAgent = req.get('User-Agent');
  const userId = req.userId || 'anonymous';
  // Correlation id from the requestId middleware — always set in practice,
  // but we defensively allow it to be missing so a misordered middleware
  // chain doesn't swallow the whole error handler.
  const requestIdVal = req.id ?? '-';

  console.log(
    `[ERROR ${timestamp}] ${statusCode} ${method} ${url}`.bgRed.bold,
    `\nRequest: ${requestIdVal}`,
    `\nUser: ${userId}`,
    `\nMessage: ${message}`.red,
    errorCode ? `\nCode: ${errorCode}` : '',
    userAgent ? `\nUA: ${userAgent.substring(0, 100)}` : '',
    ENVIRONMENT !== 'production' ? `\nStack: ${err.stack}` : '',
  );

  res.status(statusCode).json({
    message,
    ...(errorCode && { errorCode }),
    // Echo the correlation id in the error body too — clients can quote it
    // verbatim in bug reports and we can grep logs for the same value.
    requestId: requestIdVal,
    stack: ENVIRONMENT === 'production' ? null : err.stack,
  });
};
