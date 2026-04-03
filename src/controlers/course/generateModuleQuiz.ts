import asyncHandler from 'express-async-handler';
import { getUserCourse } from '@services/courseDbService';
import { submitJob } from '@services/jobRunner';
import LessonContentModel from '@models/LessonContentModel';
import { parseIndexParam } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/module-quiz/{moduleIndex}/generate:
 *   post:
 *     summary: Generate a module quiz (or regenerate for retakes)
 *     tags:
 *       - ModuleQuiz
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: moduleIndex
 *         required: true
 *         schema:
 *           type: integer
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
 *                   required: [jobId]
 *                   properties:
 *                     jobId:
 *                       type: string
 */
export const generateModuleQuizController = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId as string;
  const userId = req.userId!;
  const moduleIndex = parseIndexParam(req.params.moduleIndex, 'moduleIndex');

  const course = await getUserCourse({ userId, courseId });

  const mod = course.structure?.modules?.[moduleIndex];
  if (!mod) {
    res.status(404).json({ message: `Module ${moduleIndex} not found` });
    return;
  }

  // Validate all lessons are generated
  const lessonCount = mod.lessons?.length ?? 0;
  const generatedCount = await LessonContentModel.countDocuments({ courseId, moduleIndex });
  if (generatedCount < lessonCount) {
    res.status(400).json({
      message: `Not all lessons generated for this module (${generatedCount}/${lessonCount})`,
      errorCode: 'LESSONS_NOT_GENERATED',
    });
    return;
  }

  const jobId = await submitJob({
    userId,
    courseId,
    type: 'generate_module_quiz',
    metadata: { moduleIndex },
  });

  res.status(202).json({ data: { jobId } });
});
