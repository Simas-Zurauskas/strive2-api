import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import { parseIndexParam } from './validation';

// No @swagger block — intentionally hidden from API docs. Admin-only;
// the route applies `requireAdmin` ahead of this controller, so by the
// time we reach here the request is authorised.
export const resetModuleQuizController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const [quizContent, quizProgress] = await Promise.all([
    ModuleQuizContentModel.deleteOne({ courseId, moduleIndex }),
    UserModuleQuizProgressModel.deleteOne({ userId, courseId, moduleIndex }),
  ]);

  res.status(200).json({
    data: {
      deleted: {
        quizContent: quizContent.deletedCount > 0,
        quizProgress: quizProgress.deletedCount > 0,
      },
    },
  });
});
