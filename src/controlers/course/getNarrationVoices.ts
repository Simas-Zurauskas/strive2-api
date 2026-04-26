import asyncHandler from 'express-async-handler';
import { NARRATION_VOICES, DEFAULT_NARRATION_VOICE_ID } from '@lib/narration/voices';

/**
 * @swagger
 * /api/course/narration-voices:
 *   get:
 *     summary: List the curated TTS voices users can pick for lesson narration.
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
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
 *                   required: [voices, defaultVoiceId]
 *                   properties:
 *                     defaultVoiceId:
 *                       type: string
 *                     voices:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/NarrationVoice'
 */
export const getNarrationVoicesController = asyncHandler(async (_req, res) => {
  res.status(200).json({
    data: {
      defaultVoiceId: DEFAULT_NARRATION_VOICE_ID,
      voices: NARRATION_VOICES.map((v) => ({
        id: v.id,
        label: v.label,
        locale: v.locale,
        gender: v.gender,
        description: v.description,
      })),
    },
  });
});
