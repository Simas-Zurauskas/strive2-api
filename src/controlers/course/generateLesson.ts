import asyncHandler from 'express-async-handler';
import { submitJob } from '@services/jobRunner';
import { getUserCourseLean } from '@services/courseDbService';
import { generateLessonSchema, assertPreviousLessonGenerated } from './validation';

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
 *               includeImage:
 *                 type: boolean
 *                 default: true
 *               includeLinks:
 *                 type: boolean
 *                 default: false
 *               includeRecallCards:
 *                 type: boolean
 *                 default: true
 *                 description: >
 *                   Whether to extract spaced-retrieval recall cards from
 *                   the generated lesson. Defaults true — recall is the
 *                   highest-value optional feature pedagogically. Users
 *                   can regenerate later via /regenerate-recall.
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
  const userId = req.userId!;
  const { moduleIndex, lessonIndex, includeImage, includeLinks, includeRecallCards } =
    generateLessonSchema.parse(req.body);
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

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

  // Enforce sequential generation — previous lesson must exist
  await assertPreviousLessonGenerated({
    courseId,
    moduleIndex,
    lessonIndex,
    structure: course.structure as { modules: { lessons: unknown[] }[] },
  });

  // Image/links flags pass through to the agent unchanged. All plans get
  // full feature access — credits cost reflects what was used.
  // `activeLesson` is threaded into submitJob so it lands in the SAME
  // atomic claim as activeJobId. The previous controller-level
  // findByIdAndUpdate after submitJob raced with processJob's finally —
  // a fast pre-flight failure could clear activeLesson:null before the
  // controller's write committed, leaving a ghost activeLesson.
  const jobId = await submitJob({
    userId,
    courseId,
    type: 'generate_lesson',
    metadata: { moduleIndex, lessonIndex, includeImage, includeLinks, includeRecallCards },
    activeLesson: { moduleIndex, lessonIndex },
  });

  res.status(202).json({ data: { jobId } });
});
