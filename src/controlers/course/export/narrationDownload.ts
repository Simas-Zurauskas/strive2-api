/**
 * Narration downloads: the MP3 and its transcript.
 *
 * The audio never passes through this process. `audioUrl` already holds an
 * S3 key, so a second presign with `ResponseContentDisposition` gives the
 * browser a real download under a chosen filename at zero server cost.
 *
 * The transcript is not stored anywhere and does not need to be:
 * `blocksToNarrationScript` is a pure function and is the exact text that
 * was sent to the TTS engine.
 *
 * WHICH text, though, is the subtlety. Regenerating a lesson replaces
 * `blocks` wholesale and leaves `audioUrl`, `audioContentHash`,
 * `audioVoice` and `audioRate` untouched (`services/jobRunner.ts:579-595`
 * sets none of them), so the stored audio can be narrating a version of the
 * lesson that no longer exists. `audioContentHash` is exactly the record
 * needed to detect that, so both endpoints recompute it and say so rather
 * than silently handing over a transcript that does not match the audio.
 */

import asyncHandler from 'express-async-handler';
import LessonContentModel from '@models/LessonContentModel';
import { blocksToNarrationScript } from '@lib/narration/blocksToScript';
import { buildContentHash } from '@services/lessonNarrationService';
import { clampNarrationRate, resolveNarrationVoice } from '@lib/narration/voices';
import { getPresignedUrl } from '@services/s3Service';
import { contentDisposition, downloadFilename } from '@lib/pdf/filename';
import { parseIndexParam } from '../validation';
import { loadOwnedCourse } from './ownedCourse';

/** 15 minutes: long enough to click, short enough not to be a shareable asset. */
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

const loadNarratedLesson = async ({
  courseId,
  moduleIndex,
  lessonIndex,
  res,
}: {
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
  res: Parameters<typeof loadOwnedCourse>[0]['res'];
}) => {
  const lesson = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });
  if (!lesson) {
    res.status(404).json({ message: 'Lesson content has not been generated yet' });
    return null;
  }
  if (!lesson.audioUrl) {
    res.status(404).json({ message: 'This lesson has no narration' });
    return null;
  }
  return lesson;
};

/**
 * True when the stored audio was synthesised from the blocks as they stand
 * now. Recomputes the same hash the narration service caches on.
 */
const transcriptMatchesAudio = (lesson: {
  blocks: Parameters<typeof blocksToNarrationScript>[0];
  audioVoice: string | null;
  audioRate: number | null;
  audioContentHash: string | null;
}): boolean => {
  if (!lesson.audioContentHash) return false;
  const script = blocksToNarrationScript(lesson.blocks);
  const voice = resolveNarrationVoice(lesson.audioVoice);
  const rate = clampNarrationRate(lesson.audioRate);
  return buildContentHash({ script, voiceId: voice.id, rate }) === lesson.audioContentHash;
};

/**
 * @swagger
 * /api/course/{courseId}/lesson/{moduleIndex}/{lessonIndex}/narration/download:
 *   get:
 *     summary: Get a download link for a lesson's narration audio
 *     description: >
 *       Returns a short-lived presigned URL that saves the MP3 rather than
 *       streaming it. `transcriptMatchesAudio` is false when the lesson has
 *       been regenerated since the audio was made, so the client can warn.
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
 *       - in: path
 *         name: lessonIndex
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
 *                   $ref: '#/components/schemas/NarrationDownload'
 *       404:
 *         description: Course, lesson or narration not found.
 */
export const getNarrationDownloadController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const lessonIndex = parseIndexParam({ value: req.params.lessonIndex, name: 'lessonIndex' });

  const course = await loadOwnedCourse({ userId, courseId: req.params.courseId as string, res });
  if (!course) return;
  const courseId = course._id.toString();

  const lesson = await loadNarratedLesson({ courseId, moduleIndex, lessonIndex, res });
  if (!lesson) return;

  const filename = downloadFilename({
    parts: [course.name, `module-${moduleIndex + 1}-lesson-${lessonIndex + 1}`],
    extension: 'mp3',
    fallback: 'strive-narration',
  });

  const url = await getPresignedUrl({
    key: lesson.audioUrl!,
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    downloadFilename: filename,
  });

  res.status(200).json({
    data: { url, filename, transcriptMatchesAudio: transcriptMatchesAudio(lesson) },
  });
});

/**
 * @swagger
 * /api/course/{courseId}/lesson/{moduleIndex}/{lessonIndex}/narration/transcript:
 *   get:
 *     summary: Download the narration transcript for a lesson
 *     description: >
 *       Plain text — exactly the script that was sent to the speech engine.
 *       If the lesson has been regenerated since the audio was made, the file
 *       opens with a one-line note saying so.
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
 *       - in: path
 *         name: lessonIndex
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: The transcript.
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       404:
 *         description: Course, lesson or narration not found.
 */
export const getNarrationTranscriptController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const lessonIndex = parseIndexParam({ value: req.params.lessonIndex, name: 'lessonIndex' });

  const course = await loadOwnedCourse({ userId, courseId: req.params.courseId as string, res });
  if (!course) return;
  const courseId = course._id.toString();

  const lesson = await loadNarratedLesson({ courseId, moduleIndex, lessonIndex, res });
  if (!lesson) return;

  const script = blocksToNarrationScript(lesson.blocks);
  const stale = !transcriptMatchesAudio(lesson);
  const body = stale
    ? `[This lesson was updated after its audio was generated, so the recording may differ from the text below.]\n\n${script}`
    : script;

  const filename = downloadFilename({
    parts: [course.name, `module-${moduleIndex + 1}-lesson-${lessonIndex + 1}-transcript`],
    extension: 'txt',
    fallback: 'strive-transcript',
  });

  res
    .status(200)
    .set('Content-Type', 'text/plain; charset=utf-8')
    .set('Content-Disposition', contentDisposition(filename))
    .send(body);
});
