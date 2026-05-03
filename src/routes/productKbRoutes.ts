import { Router } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { productKbChatController } from '@controlers/productKb';
import { decodeAuthToken } from '@lib/auth';
import { optionalProtect } from '@middleware/authMiddleware';
import { usageContextMiddleware } from '@middleware/usageContext';

const router = Router();

/**
 * Key the limiter on the authenticated user when one is present, falling
 * back to the request IP for anonymous visitors. Mirrors the pattern in
 * `index.ts`'s global limiter — a signed-in user shares a bucket across
 * IPs (mobile + desktop), and an anonymous visitor's bucket is per-IP.
 *
 * Decoding the token here avoids depending on `optionalProtect` having
 * already run (rate limiters mount before the route's middleware chain).
 */
const userOrIpKey: NonNullable<Options['keyGenerator']> = (req) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const decoded = decodeAuthToken(header.split(' ')[1] ?? '');
    if (decoded?.id) return `user:${decoded.id}`;
  }
  return `ip:${req.ip ?? 'unknown'}`;
};

/**
 * Two stacked limiters keep the bot affordable without hurting normal use:
 *   - Burst: 8 messages per minute. Stops a runaway client (e.g. a button
 *     loop sending repeatedly) within seconds.
 *   - Sustained: 30 messages per hour. ~$3/hr ceiling per IP at typical
 *     Haiku token spend, which is acceptable for an anonymous help bot.
 *
 * Both message bodies surface as a friendly 429 the client can render —
 * the global limiter catches anything else.
 */
const productKbBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { message: 'You\'re sending messages too quickly. Try again in a minute.' },
  validate: { keyGeneratorIpFallback: false },
});

const productKbHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: {
    message: "You've hit the hourly chat limit. Try again later, or browse the help articles in the meantime.",
  },
  validate: { keyGeneratorIpFallback: false },
});

// Public surface: no `protect`, no `requireCredits`. The chat is free.
// `optionalProtect` attaches a userId when one is available so usage
// telemetry can bind to the user; `usageContextMiddleware` sees the
// missing userId and gracefully no-ops the AsyncLocalStorage scope (cost
// is still incurred — we just don't tag it to a person, which is the
// honest record for an anonymous visitor).
router.post(
  '/chat',
  productKbBurstLimiter,
  productKbHourlyLimiter,
  optionalProtect,
  usageContextMiddleware,
  productKbChatController,
);

export const productKbRoutes = router;
