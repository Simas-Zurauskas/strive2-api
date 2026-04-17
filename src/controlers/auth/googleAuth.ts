import { GOOGLE_CLIENT_ID } from '@conf/env';
import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import asyncHandler from 'express-async-handler';
import { OAuth2Client } from 'google-auth-library';
import { generateAuthToken } from '@lib/auth';
import { googleAuthSchema } from './validation';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * @swagger
 * /api/auth/google:
 *   post:
 *     summary: Authenticate or register via Google
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: string
 */
export const googleAuthController = asyncHandler(async (req, res) => {
  const { idToken } = googleAuthSchema.parse(req.body);

  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload?.email) {
    res.status(400);
    throw new Error('Unable to verify Google account');
  }

  // Google tokens may carry an email the user hasn't proven ownership of
  // (e.g., workspace-admin-added alias, unverified gmail). Accepting those
  // would let an attacker sign in as a victim who uses the same address
  // for credentials auth. Require Google's own verification step.
  if (!payload.email_verified) {
    res.status(400);
    throw new Error('Google account email is not verified');
  }

  const { email, sub, picture, name } = payload;

  const user = await UserModel.findOneAndUpdate(
    { email },
    {
      $set: {
        emailVerified: true,
        ...(name && { name }),
        ...(picture && { image: picture }),
      },
      $addToSet: {
        authProviders: { provider: AuthProvider.GOOGLE, providerId: sub },
      },
      $setOnInsert: { email },
    },
    { upsert: true, returnDocument: 'after' },
  );

  if (!user) {
    res.status(500);
    throw new Error('Failed to create or update user');
  }

  res.status(200).json({ data: generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion }) });
});
