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

  const statusCode = res.statusCode >= 400 ? res.statusCode : 500;
  const message = err.message || 'Something went wrong';
  const errorCode = (err as AppError).errorCode;

  // Essential error logging
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.originalUrl;
  const userAgent = req.get('User-Agent');
  const userId = req.userId || 'anonymous';

  console.log(
    `[ERROR ${timestamp}] ${statusCode} ${method} ${url}`.bgRed.bold,
    `\nUser: ${userId}`,
    `\nMessage: ${message}`.red,
    errorCode ? `\nCode: ${errorCode}` : '',
    userAgent ? `\nUA: ${userAgent.substring(0, 100)}` : '',
    ENVIRONMENT !== 'production' ? `\nStack: ${err.stack}` : '',
  );

  res.status(statusCode).json({
    message,
    ...(errorCode && { errorCode }),
    stack: ENVIRONMENT === 'production' ? null : err.stack,
  });
};
