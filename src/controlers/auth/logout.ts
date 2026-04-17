import asyncHandler from 'express-async-handler';
import UserModel from '@models/UserModel';

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Invalidate the caller's bearer token by rotating tokenVersion
 *     description: >
 *       Increments the user's `tokenVersion` on the server, which causes the
 *       `protect` middleware to reject any JWT minted under the previous
 *       version. The client should clear its session cookie alongside calling
 *       this endpoint. Idempotent in effect (further calls will 401 because
 *       the bearer is no longer valid).
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
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 *                   required: [message]
 *                   properties:
 *                     message:
 *                       type: string
 */
export const logoutController = asyncHandler(async (req, res) => {
  // $inc is atomic — concurrent logout calls from the same user just bump
  // the counter twice, which still invalidates every pre-existing token.
  // If the user document has already been deleted (race with delete-account),
  // the update is a no-op and we still return 200 — the bearer is dead either
  // way via the tokenVersion check in `protect`.
  await UserModel.findByIdAndUpdate(req.userId, { $inc: { tokenVersion: 1 } });

  res.status(200).json({ data: { message: 'Logged out' } });
});
