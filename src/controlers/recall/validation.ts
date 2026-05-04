import { z } from 'zod';
import { Types } from 'mongoose';
import { RECALL_MODES, RECALL_RATINGS } from '@lib/recallConstants';

export const rateRecallSchema = z.object({
  rating: z.number().int().refine(
    (v): v is 1 | 2 | 3 | 4 => (RECALL_RATINGS as readonly number[]).includes(v),
    { message: 'rating must be 1, 2, 3, or 4' },
  ),
  typedMatch: z.number().min(0).max(1).nullable().optional(),
});

export const setRecallModeSchema = z.object({
  mode: z.enum(RECALL_MODES),
});

/**
 * Parses an ObjectId route param. Throws 400 if invalid — avoids Mongoose
 * CastError leaking as 500.
 */
export const parseRecallCardIdParam = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) value = value[0];
  if (!value || !Types.ObjectId.isValid(value)) {
    throw Object.assign(new Error('Invalid recallCardId'), { statusCode: 400 });
  }
  return value;
};
