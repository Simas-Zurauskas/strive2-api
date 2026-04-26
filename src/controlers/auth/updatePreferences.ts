import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import UserModel from '@models/UserModel';
import {
  isKnownNarrationVoice,
  NARRATION_RATE_MAX,
  NARRATION_RATE_MIN,
} from '@lib/narration/voices';

const preferencesSchema = z.object({
  narrationVoice: z
    .string()
    .refine((v) => v === '' || isKnownNarrationVoice(v), {
      message: 'Unknown narration voice',
    })
    .optional(),
  narrationRate: z.number().min(NARRATION_RATE_MIN).max(NARRATION_RATE_MAX).optional(),
});

/**
 * @swagger
 * /api/auth/me/preferences:
 *   patch:
 *     summary: Update the authenticated user's preferences (narration voice / rate, etc.)
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
 *             properties:
 *               narrationVoice:
 *                 type: string
 *                 description: Empty string clears the preference and falls back to the catalog default.
 *               narrationRate:
 *                 type: number
 *                 minimum: 0.5
 *                 maximum: 2.0
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/AuthorisedUser'
 */
export const updatePreferencesController = asyncHandler(async (req, res) => {
  const userId = req.userId!;

  const parseResult = preferencesSchema.safeParse(req.body ?? {});
  if (!parseResult.success) {
    res.status(400);
    throw new Error(parseResult.error.issues.map((i) => i.message).join('; '));
  }
  const { narrationVoice, narrationRate } = parseResult.data;

  const update: Record<string, unknown> = {};
  if (typeof narrationVoice === 'string') update['preferences.narrationVoice'] = narrationVoice;
  if (typeof narrationRate === 'number') update['preferences.narrationRate'] = narrationRate;

  const user = await UserModel.findByIdAndUpdate(userId, update, { new: true });
  if (!user) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  res.status(200).json({ data: user });
});
