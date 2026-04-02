import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';

export const validateObjectId = (...paramNames: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const name of paramNames) {
      const value = req.params[name] as string | undefined;
      if (value && !mongoose.Types.ObjectId.isValid(value)) {
        res.status(400);
        throw new Error(`Invalid ID format: ${name}`);
      }
    }
    next();
  };
};
