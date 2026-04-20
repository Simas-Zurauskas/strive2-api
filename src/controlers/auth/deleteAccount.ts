import asyncHandler from 'express-async-handler';
import UserModel, { AuthProvider } from '@models/UserModel';
import CourseModel from '@models/CourseModel';
import JobModel from '@models/JobModel';
import CourseDesignChatModel from '@models/CourseDesignChatModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import UserInsightProgressModel from '@models/UserInsightProgressModel';
import UserGamificationModel from '@models/UserGamificationModel';
import { cleanupCourseContent } from '@services/courseCleanupService';
import { deleteAccountSchema } from './validation';

/**
 * @swagger
 * /api/auth/delete-account:
 *   delete:
 *     summary: Delete the authenticated user's account and all associated data
 *     tags:
 *       - Auth
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password:
 *                 type: string
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
 *                   required: [deleted]
 *                   properties:
 *                     deleted:
 *                       type: boolean
 *       401:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const deleteAccountController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const user = await UserModel.findById(userId).select('+password');

  if (!user) {
    res.status(401);
    throw new Error('Not authenticated');
  }

  // Require password confirmation for users with credentials auth
  const hasCredentials = user.authProviders.some((p) => p.provider === AuthProvider.CREDENTIALS);

  if (hasCredentials) {
    const { password } = deleteAccountSchema.parse(req.body);
    const isValid = await user.comparePassword(password);

    if (!isValid) {
      res.status(401);
      throw new Error('Invalid password');
    }
  }

  const courseIds = await CourseModel.find({ userId: user._id }).distinct('_id');

  // Delegate per-course cleanup to the same primitive `deleteCourse` uses so
  // the two deletion paths can't drift when new course-scoped models are added.
  // Covers lesson content, quiz content, chat, progress, insights,
  // insight-progress, and S3 assets under `lessons/{courseId}/`.
  await Promise.all(courseIds.map((id) => cleanupCourseContent(id.toString())));

  await Promise.all([
    JobModel.deleteMany({ userId: user._id }),
    UserLessonProgressModel.deleteMany({ userId: user._id }),
    UserModuleQuizProgressModel.deleteMany({ userId: user._id }),
    UserInsightProgressModel.deleteMany({ userId: user._id }),
    CourseDesignChatModel.deleteMany({ userId: user._id }),
    UserGamificationModel.deleteMany({ userId: user._id }),
    // Strip these courses from any OTHER user's favorites — `CourseModel.deleteMany`
    // below doesn't trigger the $pull that single-course deletion does.
    UserModel.updateMany(
      { favoriteCourseIds: { $in: courseIds } },
      { $pull: { favoriteCourseIds: { $in: courseIds } } },
    ),
  ]);
  await CourseModel.deleteMany({ userId: user._id });
  await UserModel.findByIdAndDelete(userId);

  console.log(`[API] Account deleted: ${userId}`.green);

  res.status(200).json({ data: { deleted: true } });
});
