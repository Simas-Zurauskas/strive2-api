import asyncHandler from 'express-async-handler';
import { submitJob } from '@services/jobRunner';
import { getUserCourse } from '@services/courseDbService';
import { generateLessonSchema } from './validation';

/**
 * @swagger
 * /api/course/{courseId}/generate-lesson:
 *   post:
 *     summary: Generate content for a specific lesson
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [moduleIndex, lessonIndex]
 *             properties:
 *               moduleIndex:
 *                 type: integer
 *                 minimum: 0
 *               lessonIndex:
 *                 type: integer
 *                 minimum: 0
 *     responses:
 *       202:
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
export const generateLessonController = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId as string;
  const userId = req.userId!;
  const { moduleIndex, lessonIndex } = generateLessonSchema.parse(req.body);

  const course = await getUserCourse({ userId, courseId });

  // Validate that the module and lesson exist in the structure
  if (!course.structure?.modules) {
    res.status(400);
    throw new Error('Course has no structure yet');
  }

  const mod = course.structure.modules[moduleIndex];
  if (!mod) {
    res.status(400);
    throw new Error(`Module ${moduleIndex} does not exist`);
  }

  const lesson = mod.lessons?.[lessonIndex];
  if (!lesson) {
    res.status(400);
    throw new Error(`Lesson ${lessonIndex} does not exist in module ${moduleIndex}`);
  }

  console.log(`[API] Submitting generate_lesson job, courseId: ${courseId}, module: ${moduleIndex}, lesson: ${lessonIndex}`.cyan);
  const jobId = await submitJob({
    userId,
    courseId,
    type: 'generate_lesson',
    metadata: { moduleIndex, lessonIndex },
  });
  console.log(`[API] Generate lesson job submitted: ${jobId}`.green);

  res.status(202).json({ data: { jobId } });
});
