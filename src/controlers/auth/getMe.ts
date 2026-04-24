import UserModel from '@models/UserModel';
import asyncHandler from 'express-async-handler';

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get the authenticated user's profile
 *     tags:
 *       - Auth
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: ['data']
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/AuthorisedUser'
 */
export const getMeController = asyncHandler(async (req, res) => {
  // Hydrated doc (no `.lean()`) so the schema's toJSON transform runs and
  // strips sensitive fields: password, tokens, tokenVersion, and Stripe
  // customer/subscription ids. With `.lean()` those leak through verbatim.
  // Perf hit vs. lean is negligible on a single-doc find.
  const user = await UserModel.findById(req.userId);

  if (!user) {
    res.status(401);
    throw new Error('Unauthorized');
  }

  res.status(200).json({ data: user });
});
