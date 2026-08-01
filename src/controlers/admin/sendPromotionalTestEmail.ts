import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import { API_URL } from '@conf/env';
import { sendDocumentsFeatureEmail } from '@services/emailService';
import MarketingContactModel from '@models/MarketingContactModel';
import { buildMarketingUnsubToken, MARKETING_UNSUB_PATH } from '@lib/marketingUnsubToken';
import { integrationLog } from '@lib/loggers';

/**
 * Real per-contact opt-out URL for a test recipient, when the address is in
 * the marketing ledger.
 *
 * `null` for an address with no row — a hand-typed QA inbox, a colleague.
 * The template then falls back to Mailjet's hosted link rather than shipping
 * a token that authorises nothing: a test whose unsubscribe link 404s would
 * teach the operator the wrong thing about the campaign.
 */
const resolveUnsubscribeUrl = async (to: string): Promise<string | undefined> => {
  const contact = await MarketingContactModel.findOne({ email: to.toLowerCase().trim() })
    .select('_id')
    .lean<{ _id: { toString(): string } } | null>();
  if (!contact) return undefined;
  return `${API_URL.replace(/\/$/, '')}${MARKETING_UNSUB_PATH}?token=${buildMarketingUnsubToken(contact._id.toString())}`;
};

// One entry per `PromotionalTemplateKey` in lib/email/templates.ts. Kept
// as an inline switch (not a Record) so adding a template forces a
// type-checked match arm — easy to grep, hard to forget.
const sendByTemplate = async (params: {
  template: 'documents_feature';
  to: string;
}): Promise<void> => {
  switch (params.template) {
    case 'documents_feature':
      await sendDocumentsFeatureEmail({
        to: params.to,
        unsubscribeUrl: await resolveUnsubscribeUrl(params.to),
      });
      return;
  }
};

const bodySchema = z.object({
  to: z.string().email(),
  // Mirror the union from `PromotionalTemplateKey`. Kept as a literal here
  // instead of imported so the OpenAPI generator can see the enum list.
  template: z.enum(['documents_feature']),
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
 *       Sends to one address only and writes no send-ledger row, so it is
 *       not a campaign and does not affect campaign idempotency. When the
 *       address is a known marketing contact the message carries that
 *       contact's real one-click unsubscribe link, so the opt-out flow can
 *       be exercised end to end; otherwise the mail provider's hosted
 *       unsubscribe link is used.
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
 *             additionalProperties: false
 *             required: [to, template]
 *             properties:
 *               to:
 *                 type: string
 *                 format: email
 *               template:
 *                 type: string
 *                 enum: [documents_feature]
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
  // No recipient address in the line. The operator already knows who they
  // typed; the log does not need to accumulate a list of addresses we mailed
  // (the same PII-in-logs class Phase 3 removed elsewhere).
  integrationLog.info(`admin:email:test ok template=${template} by=${req.userId}`);
  res.status(200).json({ data: { sent: true } });
});
