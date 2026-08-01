import type { Types } from 'mongoose';
import UserModel from '@models/UserModel';
import MarketingContactModel, { IMarketingContact } from '@models/MarketingContactModel';
import { MARKETING_EVIDENCE } from '@lib/constants';

// Migrates the existing verified user base into the marketing audience
// (PLAN Phase 3 · A2 / A2b / F2 / F14).
//
// Split out from `index.ts` so the rule below is testable without a CLI, a
// dotenv load, or a Mailjet client.
//
// ── The rule that governs this file ──────────────────────
//
// **An address already unsubscribed in Mailjet is seeded `optedOut: true`,
// and nothing here can ever re-subscribe anyone.** Mailjet's `addforce`
// action explicitly clears an unsubscribe flag, so a blanket migration that
// wrote to Mailjet would resurrect people who opted out — the one version
// of this migration that is unambiguously unlawful rather than arguable.
//
// Enforced structurally, not by operator discipline:
//   1. This module imports NO Mailjet writer. There is no code path from
//      here to `addforce`. (Pinned by a test that asserts
//      `setPromotionalSubscribed` is never called.)
//   2. New rows are written with `$setOnInsert`, so an existing row — a
//      later opt-out, an upgraded `consent` — is never overwritten.
//   3. The one update this file performs on existing rows is monotone
//      toward suppression: `optedOut: false → true`, never the reverse.
//      Needed because `$setOnInsert` cannot cover someone who was seeded
//      first and unsubscribed on Mailjet's hosted page afterwards.
//
// The suppression set is supplied by the caller rather than fetched here so
// that the fetch can fail the whole run closed before a single row is
// written — see `index.ts`.

/** Mongo bulk-write ceiling. */
const CHUNK = 1000;

export interface SeedParams {
  dryRun: boolean;
  /** Lowercased addresses that must NOT be admitted to the audience. */
  suppressedEmails: ReadonlySet<string>;
}

export interface SeedResult {
  /** Verified users considered. */
  eligible: number;
  /** Rows newly created. Zero on a dry run and on a no-op re-run. */
  inserted: number;
  /** Of the eligible cohort, how many are Mailjet-suppressed. */
  seededOptedOut: number;
  /** Pre-existing subscribed rows flipped to opted-out by this run. */
  suppressionFlipped: number;
}

export const runSeed = async (params: SeedParams): Promise<SeedResult> => {
  const { dryRun, suppressedEmails } = params;

  // `emailVerified` is the audience rule (PLAN A1): unverified addresses
  // have never proved they belong to the person, so mailing them is both a
  // deliverability and a data-protection problem. They fall out here rather
  // than through a cohort exclusion.
  const users = await UserModel.find({ emailVerified: true })
    .select('_id email')
    .lean<{ _id: Types.ObjectId; email: string }[]>();

  const now = new Date();
  const rows = users.map((u) => {
    const email = u.email.toLowerCase().trim();
    return { userId: u._id, email, suppressed: suppressedEmails.has(email) };
  });
  const seededOptedOut = rows.filter((r) => r.suppressed).length;

  if (dryRun) {
    // Report what a real run WOULD flip, without writing. The count is a
    // read-only aggregate over rows that already exist.
    const suppressedList = rows.filter((r) => r.suppressed).map((r) => r.email);
    const suppressionFlipped = suppressedList.length
      ? await MarketingContactModel.countDocuments({
          email: { $in: suppressedList },
          optedOut: false,
        })
      : 0;
    return { eligible: rows.length, inserted: 0, seededOptedOut, suppressionFlipped };
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ops = chunk.map((row) => {
      // $setOnInsert ONLY. A re-run must not touch a row the user has since
      // changed — not the basis they upgraded to `consent`, not the opt-out
      // they registered, not the evidence string.
      const insertDoc: Partial<IMarketingContact> = {
        userId: row.userId,
        email: row.email,
        basis: 'soft_opt_in',
        source: 'registration',
        // Never `signup-notice-v1`: this cohort registered before that
        // notice existed, and claiming they saw it would be a fabricated
        // provenance record (F14).
        evidence: MARKETING_EVIDENCE.SEEDED_COHORT,
        optedOut: row.suppressed,
        ...(row.suppressed ? { optedOutAt: now } : {}),
      };
      return {
        updateOne: {
          filter: { email: row.email },
          update: { $setOnInsert: insertDoc },
          upsert: true,
        },
      };
    });
    const res = await MarketingContactModel.bulkWrite(ops, { ordered: false });
    inserted += res.upsertedCount;
  }

  // Existing rows whose address has since been suppressed in Mailjet.
  // One-directional by construction — the filter requires `optedOut: false`
  // and the update only ever sets it true.
  const suppressedList = rows.filter((r) => r.suppressed).map((r) => r.email);
  let suppressionFlipped = 0;
  for (let i = 0; i < suppressedList.length; i += CHUNK) {
    const chunk = suppressedList.slice(i, i + CHUNK);
    const res = await MarketingContactModel.updateMany(
      { email: { $in: chunk }, optedOut: false },
      { $set: { optedOut: true, optedOutAt: now } },
    );
    suppressionFlipped += res.modifiedCount;
  }

  return { eligible: rows.length, inserted, seededOptedOut, suppressionFlipped };
};
