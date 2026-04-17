import { Types } from 'mongoose';
import CourseModel from '@models/CourseModel';
import InsightModel, { IInsight } from '@models/InsightModel';

/**
 * Load an insight and confirm the authenticated user owns the course it
 * belongs to. Every insight mutation endpoint must funnel through this —
 * previously the controllers only checked existence, letting any
 * authenticated user rate / skip / grade another user's insights if they
 * knew the id.
 *
 * Returns 404 (not 403) for both "insight missing" and "wrong owner" so
 * the response doesn't enumerate which insight ids exist.
 */
export const loadAuthorizedInsight = async (params: {
  userId: string;
  insightId: string;
}): Promise<IInsight & { _id: Types.ObjectId }> => {
  const insight = await InsightModel.findById(params.insightId).lean();
  if (!insight) {
    throw Object.assign(new Error('Insight not found'), { statusCode: 404 });
  }

  const owns = await CourseModel.exists({
    _id: insight.courseId,
    userId: new Types.ObjectId(params.userId),
  });
  if (!owns) {
    // Surface as 404 to avoid revealing whether the insight id exists under
    // a different user. The `errorMiddleware` honors the `statusCode` prop.
    throw Object.assign(new Error('Insight not found'), { statusCode: 404 });
  }

  return insight as IInsight & { _id: Types.ObjectId };
};
