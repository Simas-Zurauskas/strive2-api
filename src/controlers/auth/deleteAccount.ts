import asyncHandler from 'express-async-handler';
import UserModel, { AuthProvider } from '@models/UserModel';
import CourseModel from '@models/CourseModel';
import JobModel from '@models/JobModel';
import LessonContentModel from '@models/LessonContentModel';
import CourseDesignChatModel from '@models/CourseDesignChatModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import { deleteByPrefix } from '@services/s3Service';
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

  // Collect course IDs before deletion for S3 cleanup
  const courseIds = await CourseModel.find({ userId: user._id }).distinct('_id');

  await Promise.all([
    JobModel.deleteMany({ userId: user._id }),
    LessonContentModel.deleteMany({ courseId: { $in: courseIds } }),
    CourseDesignChatModel.deleteMany({ userId: user._id }),
    UserLessonProgressModel.deleteMany({ userId: user._id }),
    UserModuleQuizProgressModel.deleteMany({ userId: user._id }),
    ModuleQuizContentModel.deleteMany({ courseId: { $in: courseIds } }),
  ]);
  await CourseModel.deleteMany({ userId: user._id });
  await UserModel.findByIdAndDelete(userId);

  // Clean up S3 files for all courses — fire and forget
  Promise.all(courseIds.map((id) => deleteByPrefix(`lessons/${id}/`))).then((counts) => {
    const total = counts.reduce((sum, c) => sum + c, 0);
    if (total > 0) console.log(`[API] S3 cleanup: deleted ${total} objects for user ${userId}`.gray);
  }).catch((e) => {
    console.warn(`[API] S3 cleanup failed for user ${userId}:`, e instanceof Error ? e.message : e);
  });

  console.log(`[API] Account deleted: ${userId}`.green);

  res.status(200).json({ data: { deleted: true } });
});
