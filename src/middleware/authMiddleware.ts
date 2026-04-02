import UserModel from '@models/UserModel';
import { Request, Response, NextFunction } from 'express';
import asyncHandler from 'express-async-handler';
import { decodeAuthToken } from '@lib/auth';

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
