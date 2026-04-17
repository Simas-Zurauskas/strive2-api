import 'express';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      /** Correlation id assigned by the request-id middleware. Always set. */
      id?: string;
    }
  }
}
