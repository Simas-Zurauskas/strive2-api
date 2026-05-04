import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import { SECURITY_ACTIONS } from '@models/SecurityActionTokenModel';
import { requestSecurityActionCode } from '@services/securityActionService';

const requestCodeSchema = z.object({
  action: z.enum(SECURITY_ACTIONS),
});

/**
 * @swagger
 * /api/auth/security-action/request-code:
 *   post:
 *     summary: Request a one-time email code authorising a sensitive action
 *     description: |
 *       Sends a 6-digit confirmation code to the authenticated user's verified
 *       email. The code is required as the second factor for `set_password`,
 *       `change_password`, and `delete_account`. Code expires in 15 minutes;
 *       max 5 verify attempts; rate-limited per user (60s spacing, 5/hour).
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
 *             required: [action]
 *             properties:
 *               action:
 *                 $ref: '#/components/schemas/SecurityAction'
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
 *                   properties:
 *                     sent:
 *                       type: boolean
 *       400:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       403:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       429:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const requestSecurityActionCodeController = asyncHandler(async (req, res) => {
  const { action } = requestCodeSchema.parse(req.body);
  await requestSecurityActionCode({ userId: req.userId!, action });
  res.status(200).json({ data: { sent: true } });
});
