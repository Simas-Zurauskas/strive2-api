import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import ConsentEventModel from '@models/ConsentEventModel';
import { integrationLog } from '@lib/loggers';

/**
 * Truncate the IP for "demonstrate consent" recordkeeping.
 *
 * IPv4 → zero the last octet (`192.168.1.42` → `192.168.1.0`).
 * IPv6 → zero the last 80 bits (`2001:db8::1234:5678` → `2001:db8::`).
 *
 * Mirrors GA4's IP-anonymise default. Sufficient for "the user came from
 * roughly this region at this time"; insufficient to single out a person.
 */
const truncateIp = (ip: string | null | undefined): string | null => {
  if (!ip) return null;
  // X-Forwarded-For is comma-separated when chained — take the leftmost.
  const first = ip.split(',')[0]?.trim();
  if (!first) return null;
  if (first.includes('.') && !first.includes(':')) {
    const parts = first.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    return null;
  }
  if (first.includes(':')) {
    const parts = first.split(':');
    // Keep the first 3 hextets; zero the rest. Best-effort for short forms
    // (`::1`, `2001:db8::`) — defensible truncation in either case.
    return `${parts.slice(0, 3).join(':')}::`;
  }
  return null;
};

const recordConsentSchema = z.object({
  value: z.union([z.literal('all'), z.literal('essential'), z.null()]),
  anonymousId: z.string().min(1).max(128).nullable().optional(),
  policyVersion: z.string().min(1).max(64),
});

/**
 * @swagger
 * /api/auth/consent-log:
 *   post:
 *     summary: Record a cookie-consent decision (anonymous or authenticated)
 *     description: |
 *       GDPR Art. 7(1) requires the controller to be able to demonstrate
 *       consent. Browsers persist the user's choice in localStorage; this
 *       endpoint mirrors it server-side so we can prove "user X chose
 *       'all' on date D from approximately IP I". IP is truncated for
 *       data minimisation. Anonymous visitors are identified by a
 *       client-generated `anonymousId` (uuid stored in cookie/localStorage).
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [value, policyVersion]
 *             properties:
 *               value:
 *                 type: string
 *                 enum: [all, essential, null]
 *                 nullable: true
 *               anonymousId:
 *                 type: string
 *                 nullable: true
 *               policyVersion:
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
 *                   type: object
 *                   required: [recorded]
 *                   properties:
 *                     recorded:
 *                       type: boolean
 */
export const recordConsentController = asyncHandler(async (req, res) => {
  const { value, anonymousId, policyVersion } = recordConsentSchema.parse(req.body);

  await ConsentEventModel.create({
    userId: req.userId ? req.userId : null,
    anonymousId: anonymousId ?? null,
    value,
    policyVersion,
    ip: truncateIp(req.ip),
    userAgent: req.get('User-Agent') ?? null,
    recordedAt: new Date(),
  });

  integrationLog.info(
    `consent:record value=${value ?? 'null'} userId=${req.userId ?? '-'} anon=${anonymousId ?? '-'} policy=${policyVersion}`,
  );

  res.status(200).json({ data: { recorded: true } });
});
