import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import { sendOldUserRelaunchEmail } from '@services/emailService';
import { integrationLog } from '@lib/loggers';

// One entry per `PromotionalTemplateKey` in lib/email/templates.ts. Kept
// as an inline switch (not a Record) so adding a template forces a
// type-checked match arm — easy to grep, hard to forget.
const sendByTemplate = async (params: {
  template: 'old_user_relaunch';
  to: string;
}): Promise<void> => {
  switch (params.template) {
    case 'old_user_relaunch':
      await sendOldUserRelaunchEmail({ to: params.to });
      return;
  }
};

const bodySchema = z.object({
  to: z.string().email(),
  // Mirror the union from `PromotionalTemplateKey`. Kept as a literal here
  // instead of imported so the OpenAPI generator can see the enum list.
  template: z.enum(['old_user_relaunch']),
});

/**
 * @swagger
 * /api/admin/email/send-promotional-test:
 *   post:
 *     summary: Send a promotional email template to an arbitrary address (admin-only)
 *     description: |
 *       Operator backdoor for previewing promotional templates against real
 *       inboxes. Sends synchronously and returns the Mailjet round-trip
 *       outcome — failures bubble up as 500s so the operator sees the
 *       problem immediately rather than discovering it via Sentry.
 *
 *       Gated by `protect → requireVerified → requireAdmin`. Not exposed
 *       through any UI affordance to non-admins.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [to, template]
 *             properties:
 *               to:
 *                 type: string
 *                 format: email
 *               template:
 *                 type: string
 *                 enum: [old_user_relaunch]
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
 *                   required: [sent]
 *                   properties:
 *                     sent:
 *                       type: boolean
 *       400:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       401:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       403:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const sendPromotionalTestEmailController = asyncHandler(async (req, res) => {
  const { to, template } = bodySchema.parse(req.body);
  await sendByTemplate({ to, template });
  integrationLog.info(`admin:email:test ok template=${template} to=${to} by=${req.userId}`);
  res.status(200).json({ data: { sent: true } });
});
