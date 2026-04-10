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

  const user = await UserModel.findById(userId).select('favoriteCourseIds');
  if (!user) {
    res.status(404).json({ message: 'User not found' });
    return;
  }

  const index = user.favoriteCourseIds.findIndex((id) => id.equals(course._id));
  const isFavorited = index !== -1;

  if (isFavorited) {
    user.favoriteCourseIds.splice(index, 1);
  } else {
    user.favoriteCourseIds.push(course._id);
  }

  await user.save();

  res.status(200).json({ data: { favorited: !isFavorited } });
});
