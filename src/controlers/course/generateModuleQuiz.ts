import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
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
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const mod = course.structure?.modules?.[moduleIndex];
  if (!mod) {
    res.status(404).json({ message: `Module ${moduleIndex} not found` });
    return;
  }

  // Gate: at least 2 generated lessons in the module (or every lesson, for
  // modules smaller than that). The original all-lessons gate meant no quiz
  // was ever generated in production — real usage runs 1-2 lessons per
  // module, so the bar sat permanently out of reach. Two lessons is the
  // floor at which cross-lesson synthesis questions are possible; the quiz
  // covers the generated subset (contextLoad feeds only generated lessons).
  const lessonCount = mod.lessons?.length ?? 0;
  const requiredCount = Math.min(2, lessonCount);
  const generatedCount = await LessonContentModel.countDocuments({ courseId, moduleIndex });
  if (lessonCount === 0 || generatedCount < requiredCount) {
    res.status(400).json({
      message: `Generate at least ${requiredCount || 1} lesson${requiredCount === 1 ? '' : 's'} in this module to unlock its quiz (${generatedCount}/${lessonCount} generated)`,
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
