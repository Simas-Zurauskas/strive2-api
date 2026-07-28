import asyncHandler from 'express-async-handler';
import UserModel from '@models/UserModel';
import { integrationLog } from '@lib/loggers';
import { attributionSchema } from './validation';

/**
 * @swagger
 * /api/auth/me/attribution:
 *   post:
 *     summary: Record first-touch marketing attribution for the signed-in user
 *     description: |
 *       Writes the campaign parameters the browser captured on the visitor's
 *       first landing (UTM tags, Google/Meta click ids, referrer, landing
 *       path) onto the user record.
 *
 *       First-write-wins: once a user has attribution it is never replaced, so
 *       the stored value always answers "which campaign produced this account"
 *       rather than "which link did they last click". Calling this repeatedly
 *       is safe — replays return `recorded: false` and change nothing.
 *
 *       Every field is optional; a payload carrying no usable signal is
 *       accepted and ignored rather than rejected, so callers never have to
 *       branch on whether a visitor arrived with campaign parameters.
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               source:
 *                 type: string
 *                 description: utm_source
 *               medium:
 *                 type: string
 *                 description: utm_medium
 *               campaign:
 *                 type: string
 *                 description: utm_campaign
 *               term:
 *                 type: string
 *                 description: utm_term
 *               content:
 *                 type: string
 *                 description: utm_content
 *               gclid:
 *                 type: string
 *                 description: Google Ads click id
 *               fbclid:
 *                 type: string
 *                 description: Meta click id
 *               referrer:
 *                 type: string
 *                 description: document.referrer at first landing
 *               landingPath:
 *                 type: string
 *                 description: Path of the first page seen, without host or query
 *               capturedAt:
 *                 type: string
 *                 format: date-time
 *                 description: When the browser captured this, not when it was sent
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
 *                   required: [recorded]
 *                   properties:
 *                     recorded:
 *                       type: boolean
 *                       description: >-
 *                         True when this call stored the attribution. False when
 *                         the user already had one, or the payload carried no
 *                         usable signal.
 */
export const recordAttributionController = asyncHandler(async (req, res) => {
  const { capturedAt, ...params } = attributionSchema.parse(req.body);

  // A visitor who arrived with no campaign parameters and no referrer produces
  // an all-empty payload. Storing that would burn the one-shot first-write on
  // an empty record and mask a later, real campaign touch — so treat it as a
  // no-op rather than a write.
  const hasSignal = Object.values(params).some((v) => typeof v === 'string' && v.length > 0);
  if (!hasSignal) {
    res.status(200).json({ data: { recorded: false } });
    return;
  }

  // `attribution: { $exists: false }` in the filter is what makes this
  // first-write-wins, and it does so atomically — two concurrent calls (two
  // tabs finishing sign-in together) cannot both match, so there is no
  // read-then-write race to lose.
  const result = await UserModel.updateOne(
    { _id: req.userId, attribution: { $exists: false } },
    { $set: { attribution: { ...params, capturedAt: capturedAt ?? new Date() } } },
  );

  const recorded = result.modifiedCount > 0;
  if (recorded) {
    integrationLog.info(
      `attribution:record userId=${req.userId} source=${params.source ?? '-'} medium=${params.medium ?? '-'} campaign=${params.campaign ?? '-'}`,
    );
  }

  res.status(200).json({ data: { recorded } });
});
