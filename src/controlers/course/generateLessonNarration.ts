import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import { submitJob } from '@services/jobRunner';
import { getUserCourseLean } from '@services/courseDbService';
import LessonContentModel from '@models/LessonContentModel';
import UserModel from '@models/UserModel';
import { hasNarratableContent } from '@lib/narration/blocksToScript';
import {
  isKnownNarrationVoice,
  NARRATION_RATE_MAX,
  NARRATION_RATE_MIN,
} from '@lib/narration/voices';
import { TTS_COOLDOWN_MS } from '@services/lessonNarrationService';
import { parseIndexParam } from './validation';
import { ttsLog } from '@lib/loggers';

const narrationSchema = z.object({
  voiceId: z
    .string()
    .min(1)
    .refine(isKnownNarrationVoice, { message: 'Unknown narration voice' })
    .optional(),
  rate: z.number().min(NARRATION_RATE_MIN).max(NARRATION_RATE_MAX).optional(),
});

/**
 * @swagger
 * /api/course/{courseId}/lesson/{moduleIndex}/{lessonIndex}/narration:
 *   post:
 *     summary: Generate audio narration for a lesson (Google Cloud TTS)
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
 *       - in: path
 *         name: moduleIndex
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 0
 *       - in: path
 *         name: lessonIndex
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 0
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               voiceId:
 *                 type: string
 *                 description: Optional voice override. Falls back to the user's saved preference, then the catalog default.
 *               rate:
 *                 type: number
 *                 minimum: 0.5
 *                 maximum: 2.0
 *                 description: Optional speaking rate override.
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
 *       400:
 *         description: Lesson has not been generated, or has no narratable content.
 */
export const generateLessonNarrationController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const lessonIndex = parseIndexParam({ value: req.params.lessonIndex, name: 'lessonIndex' });

  const parseResult = narrationSchema.safeParse(req.body ?? {});
  if (!parseResult.success) {
    res.status(400);
    throw new Error(parseResult.error.issues.map((i) => i.message).join('; '));
  }
  const { voiceId, rate } = parseResult.data;

  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const lesson = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });
  if (!lesson) {
    res.status(400);
    throw new Error('Lesson content has not been generated yet');
  }
  if (!hasNarratableContent(lesson.blocks)) {
    res.status(400);
    throw new Error('Lesson has no narratable content (only quizzes / images / code)');
  }

  // Per-lesson TTS spend cooldown — set in `runLessonNarration` only on
  // cache miss (real synthesis), so identical-script re-narration via
  // cache hit is never blocked here (the job runs, hits S3 cache, no
  // spend, no field update). Blocks the rapid-double-click + repeated
  // voice toggling vectors.
  if (lesson.lastTtsSpendAt) {
    const elapsed = Date.now() - lesson.lastTtsSpendAt.getTime();
    if (elapsed < TTS_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((TTS_COOLDOWN_MS - elapsed) / 1000);
      res.status(429).set('Retry-After', String(retryAfterSec)).json({
        message: `Narration was just generated for this lesson. Try again in ${retryAfterSec}s.`,
        errorCode: 'TTS_COOLDOWN',
        meta: { retryAfterSec },
      });
      return;
    }
  }

  // Resolve the voice + rate the job will actually use, NOW (in the
  // controller, while we still have req.userId), so the resolved values
  // land in job metadata. Resolution order:
  //   1. explicit override from request body (highest priority — used by
  //      "Regenerate with new voice" flows that pass user.preferences
  //      explicitly, or admin/test calls)
  //   2. user's saved preference (`user.preferences.narrationVoice`)
  //   3. catalog default (resolveNarrationVoice fallback inside the job)
  //
  // The earlier bug: when the body had no voiceId we never looked at the
  // user's preference, fell through to catalog default, and a "Regenerate
  // with my new profile voice" flow happened to hash to the same file as
  // the user's previous Nova-default audio — instant cache hit, "nothing
  // changed". The fix is to surface step 2 here so it's deterministic
  // and visible in job metadata for debugging.
  let resolvedVoiceId: string | undefined = voiceId;
  let resolvedRate: number | undefined = rate;
  if (resolvedVoiceId === undefined || resolvedRate === undefined) {
    const userPrefs = await UserModel.findById(userId)
      .select('preferences')
      .lean();
    if (resolvedVoiceId === undefined) {
      const prefVoice = userPrefs?.preferences?.narrationVoice;
      if (prefVoice && isKnownNarrationVoice(prefVoice)) {
        resolvedVoiceId = prefVoice;
      }
    }
    if (resolvedRate === undefined) {
      const prefRate = userPrefs?.preferences?.narrationRate;
      if (typeof prefRate === 'number' && Number.isFinite(prefRate)) {
        resolvedRate = prefRate;
      }
    }
  }

  ttsLog.info(
    `request:submit userId=${userId} course=${courseId} module=${moduleIndex} lesson=${lessonIndex} ` +
      `bodyVoice=${voiceId ?? 'unset'} bodyRate=${rate ?? 'unset'} ` +
      `resolvedVoice=${resolvedVoiceId ?? 'catalog-default'} resolvedRate=${resolvedRate ?? 'catalog-default'}`,
  );

  const jobId = await submitJob({
    userId,
    courseId,
    type: 'lesson_narration',
    metadata: {
      moduleIndex,
      lessonIndex,
      ...(resolvedVoiceId ? { voiceId: resolvedVoiceId } : {}),
      ...(typeof resolvedRate === 'number' ? { rate: resolvedRate } : {}),
    },
  });

  res.status(202).json({ data: { jobId } });
});
