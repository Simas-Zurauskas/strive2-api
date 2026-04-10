import asyncHandler from 'express-async-handler';
import UserModel from '@models/UserModel';

/**
 * @swagger
 * /api/course/favorites:
 *   get:
 *     summary: Get the list of favorited course IDs
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: string
 */
export const getFavoriteCourseIdsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const user = await UserModel.findById(userId).select('favoriteCourseIds');
  if (!user) {
    res.status(404).json({ message: 'User not found' });
    return;
  }

  res.status(200).json({ data: user.favoriteCourseIds.map((id) => id.toString()) });
});
