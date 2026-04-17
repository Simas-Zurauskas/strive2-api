import asyncHandler from 'express-async-handler';
import UserModel from '@models/UserModel';
import { getUserCourse } from '@services/courseDbService';

/**
 * @swagger
 * /api/course/favorite/{courseId}:
 *   post:
 *     summary: Toggle a course as favorite/unfavorite
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 *                   required: [favorited]
 *                   properties:
 *                     favorited:
 *                       type: boolean
 */
export const toggleFavoriteCourseController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await getUserCourse({ userId, courseId: req.params.courseId as string });

  // Two-step atomic toggle. The prior read-splice-save pattern lost data on
  // concurrent clicks — both clients would start from the same pre-toggle
  // array, both would save their half of the change, last write wins.
  //
  // Step 1: conditionally add (filter requires the id be absent).
  // Step 2: if step 1's filter missed, the id was already present — pull it.
  // Each step is a single atomic Mongo op. Two concurrent toggles resolve
  // the same as "add then remove", which is the correct semantics for a
  // user double-tapping the favorite button.
  const added = await UserModel.findOneAndUpdate(
    { _id: userId, favoriteCourseIds: { $ne: course._id } },
    { $push: { favoriteCourseIds: course._id } },
    { projection: { _id: 1 } },
  );

  if (added) {
    res.status(200).json({ data: { favorited: true } });
    return;
  }

  await UserModel.updateOne({ _id: userId }, { $pull: { favoriteCourseIds: course._id } });
  res.status(200).json({ data: { favorited: false } });
});
