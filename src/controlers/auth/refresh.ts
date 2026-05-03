import asyncHandler from 'express-async-handler';
import UserModel from '@models/UserModel';
import { generateAuthToken } from '@lib/auth';
import { AppError } from '@middleware/errorMiddleware';

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Issue a fresh access token for a still-valid session
 *     description: |
 *       Sliding-refresh entrypoint. Accepts a still-valid bearer token (the
 *       same one the client already holds) and returns a fresh 7-day access
 *       token. Re-checks `tokenVersion` against the DB so a token whose
 *       version has been bumped (logout, password change, change-password)
 *       refuses to refresh and forces re-authentication.
 *
 *       The client (NextAuth jwt callback) should call this when the JWT
 *       is within ~24h of expiry — early enough that a network blip
 *       doesn't strand the user on an expired token, late enough that
 *       short sessions don't generate refresh churn.
 *
 *       This endpoint does NOT require email verification (`requireVerified`)
 *       — sliding-refresh is a session-management primitive that should
 *       work regardless of verification state. Feature routes still gate
 *       behind `requireVerified` separately.
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
 *                   required: [token]
 *                   properties:
 *                     token:
 *                       type: string
 *       401:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const refreshTokenController = asyncHandler(async (req, res) => {
  // `protect` already validated the bearer token, populated `req.userId`,
  // and verified that `tokenVersion` still matches the DB. By the time we
  // reach this handler, we know the token is good. We re-read the user to
  // pick up the *current* tokenVersion (in case it was bumped by a parallel
  // request a millisecond ago) and to guard against the user having been
  // deleted since the original lookup.
  const user = await UserModel.findById(req.userId).select('tokenVersion').lean();
  if (!user) {
    res.status(401);
    throw new AppError('Session no longer valid', { errorCode: 'SESSION_INVALID' });
  }

  const token = generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion });
  res.status(200).json({ data: { token } });
});
