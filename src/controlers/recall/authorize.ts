import { Types } from 'mongoose';
import CourseModel from '@models/CourseModel';
import RecallCardModel, { IRecallCard } from '@models/RecallCardModel';

/**
 * Load a recall card and confirm the authenticated user owns the course it
 * belongs to. Every recall card mutation endpoint must funnel through this —
 * previously the controllers only checked existence, letting any
 * authenticated user rate / skip / grade another user's recall cards if they
 * knew the id.
 *
 * Returns 404 (not 403) for both "recall card missing" and "wrong owner" so
 * the response doesn't enumerate which recall card ids exist.
 */
export const loadAuthorizedRecallCard = async (params: {
  userId: string;
  recallCardId: string;
}): Promise<IRecallCard & { _id: Types.ObjectId }> => {
  const card = await RecallCardModel.findById(params.recallCardId).lean();
  if (!card) {
    throw Object.assign(new Error('Recall card not found'), { statusCode: 404 });
  }

  const owns = await CourseModel.exists({
    _id: card.courseId,
    userId: new Types.ObjectId(params.userId),
  });
  if (!owns) {
    // Surface as 404 to avoid revealing whether the recall card id exists under
    // a different user. The `errorMiddleware` honors the `statusCode` prop.
    throw Object.assign(new Error('Recall card not found'), { statusCode: 404 });
  }

  return card as IRecallCard & { _id: Types.ObjectId };
};
