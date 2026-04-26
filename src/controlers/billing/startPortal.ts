import asyncHandler from 'express-async-handler';
import { createPortalSession } from '@services/stripeService';

/**
 * @swagger
 * /api/billing/portal:
 *   post:
 *     summary: Create a Stripe Customer Portal session (self-serve subscription management)
 *     tags: [Billing]
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
 *                   required: [url]
 *                   properties:
 *                     url:
 *                       type: string
 */
export const startPortalController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const session = await createPortalSession({ userId });
  res.json({ data: { url: session.url } });
});
