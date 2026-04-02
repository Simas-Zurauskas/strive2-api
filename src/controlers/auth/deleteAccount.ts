import asyncHandler from 'express-async-handler';
import UserModel, { AuthProvider } from '@models/UserModel';
import CourseModel from '@models/CourseModel';
import JobModel from '@models/JobModel';
import ChatSessionModel from '@models/ChatSessionModel';
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

  await JobModel.deleteMany({ userId: user._id });
  await CourseModel.deleteMany({ userId: user._id });
  await ChatSessionModel.deleteMany({ userId: user._id });
  await UserModel.findByIdAndDelete(userId);

  console.log(`[API] Account deleted: ${userId}`.green);

  res.status(200).json({ data: { deleted: true } });
});
