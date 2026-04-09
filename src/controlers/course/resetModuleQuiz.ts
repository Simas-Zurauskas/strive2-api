import asyncHandler from 'express-async-handler';
import { ENVIRONMENT } from '@conf/env';
import { getUserCourse } from '@services/courseDbService';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import { parseIndexParam } from './validation';

// No @swagger block — intentionally hidden from API docs.
export const resetModuleQuizController = asyncHandler(async (req, res) => {
  if (ENVIRONMENT !== 'development') {
    res.status(404).json({ message: 'Not found' });
    return;
  }

  const courseId = req.params.courseId as string;
  const userId = req.userId!;
  const moduleIndex = parseIndexParam(req.params.moduleIndex, 'moduleIndex');

  await getUserCourse({ userId, courseId });

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
