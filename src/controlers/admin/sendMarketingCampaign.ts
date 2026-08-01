import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import { z } from 'zod';
import { API_URL, ENVIRONMENT } from '@conf/env';
import { AppError } from '@middleware/errorMiddleware';
import {
  MARKETING_CAMPAIGNS,
  type MarketingCampaign,
  type MarketingSendResult,
} from '@lib/constants';
import MarketingContactModel, {
  PROMOTIONAL_AUDIENCE_FILTER,
  findPromotionalAudience,
  type PromotionalAudienceRow,
} from '@models/MarketingContactModel';
import MarketingSendModel from '@models/MarketingSendModel';
import { buildMarketingUnsubToken, MARKETING_UNSUB_PATH } from '@lib/marketingUnsubToken';
import { assertSenderIdentityComplete } from '@lib/email/tokens';
import { sendDocumentsFeatureEmail } from '@services/emailService';
import {
  fetchPromotionalSuppression,
  MailjetSuppressionUnavailableError,
} from '@services/mailjetSuppressionSync';
import { integrationLog } from '@lib/loggers';

// Bulk promotional send: claim-then-send, one HTTP request per batch.
//
// The shape — sequential awaits inside one request, operator-driven batch
// size, atomic per-recipient claim with rollback on failure — rests on four
// properties, each of which has a silent-failure mode if dropped:
//
//   1. **The claim upserts.** A CAS that does not upsert
//      (`findOneAndUpdate` with no upsert) returns null for every recipient
//      against an empty ledger, so a brand-new campaign would send nothing at
//      all and report the whole audience as "not in list" (F18). Here the
//      claim inserts the row it is claiming, and the unique
//      `(campaignKey, email)` index turns the concurrent-duplicate case into
//      an `E11000` we map to `already_sent`.
//   2. **The audience is derived server-side** from the Phase-3 ledger
//      predicate, never from a list the client supplies. The client MAY name
//      addresses (for a targeted retry) but an address absent from the ledger
//      is refused, never auto-created.
//   3. **The suppression set is refreshed at the start of every batch**, not
//      once per campaign, so someone who unsubscribes during a run is
//      honoured on the next batch rather than at the end of the campaign.
//   4. **Pacing and a time budget.** A 1,000-address burst from a warm-less
//      sender is how a domain earns a reputation problem; and a batch that
//      outruns the reverse-proxy timeout loses the operator's result table
//      while the sends continue. Both are bounded below.
//
// Recipient addresses are never logged (Phase 3 found and fixed exactly that
// class of leak); counts and campaign keys are.

/** Hard ceiling per request (PLAN A13). At the 1,000-user design target a
 *  50-per-batch cap would mean twenty operator round trips. */
const MAX_BATCH_SIZE = 250;
const DEFAULT_BATCH_SIZE = 50;

/** Inter-send pause. Spreads a run instead of bursting it; small enough that
 *  a default-size batch still completes well inside one request. */
const INTER_SEND_DELAY_MS = 150;

/** Wall-clock budget for one batch. Past it, remaining recipients are
 *  reported `deferred` and left unclaimed, so the next batch picks them up.
 *  Deliberately below a typical 120s proxy timeout: a response the operator
 *  never receives is a batch whose outcome nobody can read. */
const BATCH_TIME_BUDGET_MS = 100_000;

/** A claim older than this with no confirmed send is treated as stranded. */
export const STRANDED_CLAIM_AFTER_MS = 10 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Campaign → template binding, pinned SERVER-side (F17).
 *
 * The operator picks a campaign, never a template. A key typo therefore
 * fails validation instead of aiming an arbitrary template at an arbitrary
 * audience, and the pairing that decides what a thousand people read lives
 * in version control rather than in a dropdown.
 */
const CAMPAIGN_SENDERS: Record<
  MarketingCampaign,
  {
    template: string;
    send: (params: { to: string; unsubscribeUrl?: string }) => Promise<void>;
  }
> = {
  'documents-feature-2026-08': {
    template: 'documents_feature',
    send: sendDocumentsFeatureEmail,
  },
};

/**
 * Mailjet signals an undeliverable recipient at send time for a subset of
 * cases (syntactically invalid or already hard-bounced addresses); the rest
 * arrive asynchronously as bounce events we do not consume.
 *
 * So this is a *partial* implementation of PLAN A13's bounce handling, and
 * saying so is the point: it suppresses what we can see, and the honest gap
 * — no bounce webhook — is recorded rather than implied away. Everything
 * unrecognised is treated as transient, because rolling a claim back is
 * cheap and wrongly marking a good address permanently undeliverable is not.
 */
const isHardBounce = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return /mj-0013|invalid\s+(email|recipient)|recipient.*(invalid|blocked)/i.test(message);
};

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: number }).code === 11000;

const bodySchema = z.object({
  campaignKey: z.enum(MARKETING_CAMPAIGNS),
  batchSize: z.number().int().min(1).max(MAX_BATCH_SIZE).optional(),
  // Optional targeted list. Present, it replaces the "next N eligible"
  // selection — every address is still checked against the ledger and an
  // unknown one is refused.
  emails: z.array(z.string().email()).min(1).max(MAX_BATCH_SIZE).optional(),
  // Typed confirmation, mirrored from the UI. Cheap, and the one guard that
  // survives a mis-click on a button labelled "send to everyone".
  confirm: z.string(),
});

interface RecipientResult {
  email: string;
  status: MarketingSendResult;
  error?: string;
}

/**
 * Absolute, per-contact opt-out URL — the target of both the footer link and
 * the `List-Unsubscribe` header.
 *
 * Guarded on the origin because the failure is invisible until a recipient
 * clicks: a production send built against a localhost `API_URL` ships a dead
 * opt-out link to the whole audience, and an opt-out we cannot honour is the
 * one defect in this system that cannot be fixed after the fact.
 */
const buildUnsubscribeUrl = (contactId: string): string =>
  `${API_URL.replace(/\/$/, '')}${MARKETING_UNSUB_PATH}?token=${buildMarketingUnsubToken(contactId)}`;

const assertUsableOrigin = (): void => {
  if (ENVIRONMENT === 'production' && /^https?:\/\/localhost/i.test(API_URL)) {
    throw new AppError(
      'API_URL still points at localhost — every unsubscribe link in this campaign would be dead. Set API_URL before sending.',
      { errorCode: 'CUSTOM_ERROR', statusCode: 500 },
    );
  }
};

/** Addresses that must never be offered a promotional message again. */
const fetchHardBouncedAddresses = async (): Promise<Set<string>> => {
  const rows = await MarketingSendModel.distinct('email', { status: 'hard_bounced' });
  return new Set(rows.map((e) => String(e).toLowerCase()));
};

/**
 * @swagger
 * /api/admin/marketing/send:
 *   post:
 *     summary: Send one paced batch of a promotional campaign (admin-only)
 *     description: |
 *       Sends the campaign's pinned template to eligible marketing contacts,
 *       one batch per request. The audience is derived on the server from the
 *       marketing contact ledger; the template is bound to the campaign key
 *       server-side and cannot be chosen by the caller.
 *
 *       Idempotent per recipient: a unique `(campaignKey, email)` constraint
 *       backs an atomic claim, so a repeated request reports `already_sent`
 *       rather than sending twice, and two concurrent callers resolve to one
 *       message per address. A send failure rolls the claim back so the
 *       address is retried by a later batch.
 *
 *       Before each batch the vendor suppression list is re-read; if it
 *       cannot be read the batch is refused rather than sent to an audience
 *       of unknown opt-out state. Addresses recorded as hard bounces on any
 *       campaign are excluded.
 *
 *       Sends are paced, and a batch that exhausts its wall-clock budget
 *       reports the remaining recipients as `deferred` without claiming them.
 *
 *       Gated by `protect → requireVerified → requireAdmin`.
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
 *             required: [campaignKey, confirm]
 *             properties:
 *               campaignKey:
 *                 type: string
 *                 enum: [documents-feature-2026-08]
 *               batchSize:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 250
 *                 description: Recipients to attempt in this request. Defaults to 50.
 *               emails:
 *                 type: array
 *                 maxItems: 250
 *                 items:
 *                   type: string
 *                   format: email
 *                 description: |
 *                   Optional targeted list. When present it replaces the
 *                   next-eligible selection. An address with no contact
 *                   ledger row is refused, never created.
 *               confirm:
 *                 type: string
 *                 description: Must equal `campaignKey`.
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
 *                   required: [campaignKey, results, sentCount, skippedCount, failedCount, audienceCount, remainingCount, suppressedCount]
 *                   properties:
 *                     campaignKey:
 *                       type: string
 *                       enum: [documents-feature-2026-08]
 *                     results:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [email, status]
 *                         properties:
 *                           email:
 *                             type: string
 *                             format: email
 *                           status:
 *                             type: string
 *                             enum: [sent, already_sent, not_in_audience, suppressed, failed, deferred]
 *                           error:
 *                             type: string
 *                             nullable: true
 *                     sentCount:
 *                       type: integer
 *                     skippedCount:
 *                       type: integer
 *                     failedCount:
 *                       type: integer
 *                     audienceCount:
 *                       type: integer
 *                       description: Contacts eligible for this campaign in total.
 *                     remainingCount:
 *                       type: integer
 *                       description: Eligible contacts still awaiting a send after this batch.
 *                     suppressedCount:
 *                       type: integer
 *                       description: Addresses excluded by the vendor suppression list or a recorded hard bounce.
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
 *       503:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
export const sendMarketingCampaignController = asyncHandler(async (req, res) => {
  const { campaignKey, batchSize, emails, confirm } = bodySchema.parse(req.body);

  if (confirm !== campaignKey) {
    throw new AppError('Confirmation text does not match the campaign key.', {
      errorCode: 'CUSTOM_ERROR',
      statusCode: 400,
    });
  }

  // Retained hook for a pre-send sender-identity check. Currently a no-op:
  // the registered address / registration number were removed from the
  // message body by founder decision (2026-07-30) — see lib/email/tokens.ts.
  // Previously blocked the send while those values were still
  // placeholders. A commercial email without them is defective in a way no
  // later fix reaches, because the messages are already delivered.
  assertSenderIdentityComplete();
  assertUsableOrigin();

  const campaign = CAMPAIGN_SENDERS[campaignKey];
  const adminId = req.userId;
  const sentByUserId = adminId ? new mongoose.Types.ObjectId(adminId) : undefined;
  const deadline = Date.now() + BATCH_TIME_BUDGET_MS;

  // Fail closed. A partial suppression set silently reclassifies everyone it
  // missed as safe to mail, which is precisely the resurrection of an
  // unsubscriber that PLAN A2b forbids.
  let suppressed: ReadonlySet<string>;
  try {
    ({ suppressed } = await fetchPromotionalSuppression());
  } catch (err) {
    if (err instanceof MailjetSuppressionUnavailableError) {
      throw new AppError(
        'Could not read the vendor suppression list — refusing to send to an audience of unknown opt-out state. Retry once the mail provider responds.',
        { errorCode: 'CUSTOM_ERROR', statusCode: 503 },
      );
    }
    throw err;
  }

  const hardBounced = await fetchHardBouncedAddresses();
  const excluded = (email: string): boolean => suppressed.has(email) || hardBounced.has(email);

  // Whole eligible audience, oldest contact first so batches walk the ledger
  // in a stable order across requests.
  const audience = (await findPromotionalAudience()).sort((a, b) =>
    a._id.toString().localeCompare(b._id.toString()),
  );
  const byEmail = new Map(audience.map((c) => [c.email.toLowerCase(), c]));

  // Addresses already claimed or delivered on this campaign. Read once per
  // batch — the per-recipient CAS below is what actually guarantees
  // exclusivity; this only keeps the batch from spending its budget on
  // recipients it would immediately skip.
  const alreadyHandled = new Set(
    (
      await MarketingSendModel.find({
        campaignKey,
        status: { $in: ['claiming', 'sent', 'hard_bounced'] },
      })
        .select('email')
        .lean<{ email: string }[]>()
    ).map((r) => r.email.toLowerCase()),
  );

  const eligible = audience.filter(
    (c) => !alreadyHandled.has(c.email.toLowerCase()) && !excluded(c.email.toLowerCase()),
  );

  const results: RecipientResult[] = [];
  let selected: PromotionalAudienceRow[];

  if (emails) {
    selected = [];
    for (const raw of emails) {
      const email = raw.toLowerCase().trim();
      const contact = byEmail.get(email);
      if (!contact) {
        // Absent from the ledger, or opted out (the ledger query excludes
        // those). Refused — never auto-created: a contact row is a record of
        // a lawful basis, and inventing one to satisfy a send is exactly the
        // fabrication the ledger exists to prevent.
        results.push({ email, status: 'not_in_audience' });
        continue;
      }
      if (excluded(email)) {
        results.push({ email, status: 'suppressed' });
        continue;
      }
      selected.push(contact);
    }
  } else {
    selected = eligible.slice(0, batchSize ?? DEFAULT_BATCH_SIZE);
  }

  let attempted = 0;
  for (const contact of selected) {
    const email = contact.email.toLowerCase();

    if (Date.now() > deadline) {
      results.push({ email, status: 'deferred' });
      continue;
    }
    if (attempted > 0) await sleep(INTER_SEND_DELAY_MS);
    attempted += 1;

    // Re-read the opt-out immediately before claiming. The remaining window
    // is one recipient wide: someone who unsubscribes after this read still
    // receives this one message, and the suppression refresh at the top of
    // the next batch closes it from there.
    const fresh = await MarketingContactModel.findById(contact._id)
      .select('optedOut')
      .lean<{ optedOut: boolean } | null>();
    if (!fresh || fresh.optedOut) {
      results.push({ email, status: 'not_in_audience' });
      continue;
    }

    // ── Claim ───────────────────────────────────────────────
    // Eligibility and consumption in one write. `claimedAt: {$exists:false}`
    // matches a fresh row (upsert-inserted) or one whose previous attempt
    // failed and was rolled back; a row that already holds a claim fails the
    // filter, the upsert attempts an insert, and the unique index answers.
    const claimedAt = new Date();
    let claimed;
    try {
      claimed = await MarketingSendModel.findOneAndUpdate(
        { campaignKey, email, claimedAt: { $exists: false } },
        {
          $set: { claimedAt, status: 'claiming', contactId: contact._id, sentByUserId },
          $inc: { attempts: 1 },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      );
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        results.push({ email, status: 'already_sent' });
        continue;
      }
      throw err;
    }
    // Unreachable while `upsert` is set — the write either matches, inserts,
    // or raises the duplicate-key error above. Checked anyway because this
    // is the exact line that decides whether a paid send happens: without
    // `upsert` the same call returns null against an empty collection, and a
    // caller that ignores the result would send with no ledger row and no
    // double-send guard at all (F18, data-integrity §2).
    if (!claimed) {
      results.push({ email, status: 'already_sent' });
      continue;
    }

    // ── Send ────────────────────────────────────────────────
    try {
      await campaign.send({
        to: email,
        unsubscribeUrl: buildUnsubscribeUrl(contact._id.toString()),
      });

      // Fenced on the claim we just took, so a concurrent operator reclaim
      // cannot be overwritten by this write.
      const finalize = await MarketingSendModel.updateOne(
        { campaignKey, email, claimedAt },
        { $set: { status: 'sent', sentAt: new Date() }, $unset: { lastError: '' } },
      );
      if (finalize.matchedCount === 0) {
        // The claim was released underneath us (a reclaim, ten minutes of
        // clock skew). The message DID go out, so the operator is told
        // `sent`; the row will read `failed` and could produce one duplicate
        // on a later batch. Logged loudly because it is the only path in
        // this controller that can double-send.
        integrationLog.warn(
          `admin:marketing:send finalize-lost campaign=${campaignKey} — claim released mid-send`,
        );
      }
      results.push({ email, status: 'sent' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      if (isHardBounce(err)) {
        // Keep the claim: this address is done, on this campaign and every
        // later one (PLAN A13).
        await MarketingSendModel.updateOne(
          { campaignKey, email },
          { $set: { status: 'hard_bounced', lastError: message } },
        );
        results.push({
          email,
          status: 'failed',
          error: `hard bounce — suppressed from future campaigns (${message})`,
        });
      } else {
        // Roll the claim back so a later batch retries. Leaving `claimedAt`
        // set would silently drop this recipient from the campaign.
        await MarketingSendModel.updateOne(
          { campaignKey, email },
          { $set: { status: 'failed', lastError: message }, $unset: { claimedAt: '' } },
        );
        results.push({ email, status: 'failed', error: message });
      }
    }
  }

  const sentCount = results.filter((r) => r.status === 'sent').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;
  const skippedCount = results.length - sentCount - failedCount;

  const audienceCount = await MarketingContactModel.countDocuments(PROMOTIONAL_AUDIENCE_FILTER);
  const deliveredNow = new Set(
    results.filter((r) => r.status === 'sent').map((r) => r.email),
  );
  const remainingCount = eligible.filter((c) => !deliveredNow.has(c.email.toLowerCase())).length;
  const suppressedCount = audience.filter((c) => excluded(c.email.toLowerCase())).length;

  integrationLog.info(
    `admin:marketing:send campaign=${campaignKey} template=${campaign.template} sent=${sentCount} skipped=${skippedCount} failed=${failedCount} remaining=${remainingCount} by=${adminId}`,
  );

  res.status(200).json({
    data: {
      campaignKey,
      results,
      sentCount,
      skippedCount,
      failedCount,
      audienceCount,
      remainingCount,
      suppressedCount,
    },
  });
});
