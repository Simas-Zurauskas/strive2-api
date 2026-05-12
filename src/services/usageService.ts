import mongoose from 'mongoose';
import UsageEventModel from '@models/UsageEventModel';
import { bgError } from '@lib/bg';
import { getUsageContext } from '@lib/usageContext';
import { UsageService } from '@lib/usageConstants';
import { applyMarkup } from '@lib/pricing';
import { PRICING_CONFIG } from '@lib/pricingConfig';

/**
 * Append one row to the per-user usage ledger AND increment the active
 * scope's in-memory spend accumulator.
 *
 * Pulls the user + job/course attribution off the AsyncLocalStorage scope so
 * call sites don't need to know anything about the current request or job.
 * The DB write is fire-and-forget (`.catch(bgError(...))`) so a Mongo hiccup
 * logs red + captures to Sentry but never throws up the stack into the
 * user-visible path (lesson generation / code execution / search).
 *
 * The accumulator increment is synchronous and ALWAYS happens first — it's
 * what `debitActualSpend` reads at job end to charge the user. A lost DB
 * write is a bug in our analytics; a lost accumulator increment is a bug
 * in the user's credit balance. Increment → then write.
 *
 * No-ops when:
 *   - there's no active usage context (bg reapers, tests, standalone scripts)
 *   - `costMicroCents` <= 0 (missing price table entry, zero-token call, etc.)
 */
export const recordUsage = ({
  service,
  action,
  costMicroCents,
  metadata,
}: {
  service: UsageService;
  action: string;
  costMicroCents: number;
  metadata?: Record<string, unknown>;
}): void => {
  const ctx = getUsageContext();
  if (!ctx) return;
  if (!Number.isFinite(costMicroCents) || costMicroCents <= 0) return;

  // The user is debited against `chargedMicroCents` (vendor cost × markup).
  // Markup is ACTION-driven: `applyMarkup` resolves the category from the
  // action label (only `lesson:content` qualifies for the lesson premium;
  // everything else — including supporting calls inside a lesson job like
  // recall extraction, link search, image generation — bills at `other`).
  // The bucket snapshot still drives the allowance-vs-bonus rate split.
  const chargedMicroCents = applyMarkup({
    action,
    creditBucket: ctx.creditBucketAtScope,
    costMicroCents,
  });

  // Increment the scope's running user-charged total BEFORE the DB write so
  // a DB failure can't desync the accumulator from the analytics ledger
  // (they diverge by the lost row, which is acceptable; the opposite — a
  // row written but not counted — would silently under-charge the user).
  ctx.spendMicroCents.current += chargedMicroCents;

  const userId = new mongoose.Types.ObjectId(ctx.userId);
  const mergedMetadata = {
    ...(metadata ?? {}),
    source: ctx.source,
    ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
    ...(ctx.courseId ? { courseId: ctx.courseId } : {}),
    ...(ctx.moduleIndex !== undefined ? { moduleIndex: ctx.moduleIndex } : {}),
    ...(ctx.lessonIndex !== undefined ? { lessonIndex: ctx.lessonIndex } : {}),
  };

  UsageEventModel.create({
    userId,
    timestamp: new Date(),
    service,
    action,
    costMicroCents,
    chargedMicroCents,
    pricingVersion: PRICING_CONFIG.pricingVersion,
    ...(ctx.plan ? { planAtTime: ctx.plan } : {}),
    ...(ctx.subscriptionStatus ? { subscriptionStatusAtTime: ctx.subscriptionStatus } : {}),
    metadata: mergedMetadata,
  }).catch(bgError('usage.record'));
};
