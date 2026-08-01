import { withRetry } from '@lib/retry';
import { integrationLog } from '@lib/loggers';
import { copyObject, deleteObject } from '@services/s3Service';
import SourceDocumentModel from '@models/SourceDocumentModel';
import ContentFlagModel, { CONTENT_FLAG_RETENTION_DAYS } from '@models/ContentFlagModel';

/**
 * Pluggable CSAM hash-match stage (plan §3.5, Q6 "do what's needed, no
 * v2"): a minimal PhotoDNA Cloud match client that ships DARK and turns
 * on by configuration once the Microsoft application (L1) is approved.
 *
 * Day-one state: disabled → `{screened: false}` no-op. omni-moderation
 * (documentModeration.ts) is the interim screen and permanent backstop.
 *
 * On a MATCH:
 *   1. the raw S3 object is copied to `quarantine/{userId}/{documentId}`
 *      and the original deleted;
 *   2. the SourceDocument is marked `rejected` with the OPAQUE generic
 *      `rejectionReason: 'policy'` — detection is NEVER disclosed to the
 *      uploader (plan §3.5);
 *   3. an admin-only `ContentFlag` audit row is written (365-day TTL —
 *      the REPORT Act evidence window). Reporting itself follows the L1
 *      NCMEC runbook; nothing here is user-facing or in swagger.
 *
 * Provider outage: throws — the caller fails the document/job closed
 * (retryable). A hash screen that cannot run never passes content.
 */

// ── Env gate ───────────────────────────────────────────────
//
// DELIBERATE exception to the boot-required `getEnv` pattern (plan §3.5):
// PhotoDNA access is application-gated and the keys will not exist at
// launch. `getEnv` would make them boot failures; instead they are read
// lazily at call time so the stage activates by setting
// PHOTODNA_API_KEY + PHOTODNA_ENDPOINT — no code change, no boot risk
// while the application is pending. Comment kept at the read site on
// purpose; do not migrate these two keys into conf/env.ts.

export const isHashScreenEnabled = (): boolean =>
  Boolean(process.env.PHOTODNA_API_KEY && process.env.PHOTODNA_ENDPOINT);

// ── Constants ──────────────────────────────────────────────

/**
 * Quarantine prefix sits OUTSIDE `uploads/` on purpose: course deletion
 * and account deletion wipe `uploads/{userId}/…` by prefix, and the
 * REPORT Act requires flagged material be preserved for 1 year as
 * evidence — a prefix-wipe must never purge it. Cleanup of quarantined
 * objects is manual, per the L1 runbook, after the retention window.
 */
export const QUARANTINE_PREFIX = 'quarantine/';

export const HASH_SCREEN_TIMEOUT_MS = 15_000;
const HASH_SCREEN_LABEL = 'doc:hash-screen';

// ── Types ──────────────────────────────────────────────────

export interface HashScreenInput {
  /** Uploaded image + all document-embedded images, raw bytes. */
  images: Array<{ buffer: Buffer; mimeType: string }>;
  userId: string;
  courseId: string;
  documentId: string;
  /** S3 key of the raw uploaded object — moved to quarantine on a match. */
  s3Key: string;
}

export type HashScreenResult =
  | { screened: false }
  | { screened: true; matched: false }
  | { screened: true; matched: true; rejectionReason: 'policy' };

// ── PhotoDNA Cloud match call ──────────────────────────────
//
// Minimal HTTP client by design (plan hard rule: no new deps — global
// fetch). PhotoDNA Cloud "Match" API shape: POST the raw image bytes to
// the configured endpoint with the subscription key header; the response
// carries `IsMatch` plus tracking metadata.

interface PhotoDnaResponse {
  IsMatch?: boolean;
  TrackingId?: string;
  ContentId?: string;
  Status?: { Code?: number; Description?: string };
}

const matchImage = async (image: {
  buffer: Buffer;
  mimeType: string;
}): Promise<{ isMatch: boolean; matchMeta: Record<string, unknown> }> => {
  const endpoint = process.env.PHOTODNA_ENDPOINT as string;
  const apiKey = process.env.PHOTODNA_API_KEY as string;

  const body = await withRetry(
    async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HASH_SCREEN_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': apiKey,
            'Content-Type': image.mimeType,
          },
          body: new Uint8Array(image.buffer),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`photodna http ${res.status}`);
        return (await res.json()) as PhotoDnaResponse;
      } finally {
        clearTimeout(timer);
      }
    },
    { label: HASH_SCREEN_LABEL, maxRetries: 2, baseDelayMs: 500 },
  );

  return {
    isMatch: body.IsMatch === true,
    // Minimal, non-content metadata only — enough for the NCMEC runbook
    // to reference the provider transaction.
    matchMeta: {
      trackingId: body.TrackingId ?? null,
      contentId: body.ContentId ?? null,
      statusCode: body.Status?.Code ?? null,
    },
  };
};

// ── Match handling ─────────────────────────────────────────

const quarantineMatch = async (
  input: HashScreenInput,
  matchMeta: Record<string, unknown>,
): Promise<HashScreenResult> => {
  const quarantineKey = `${QUARANTINE_PREFIX}${input.userId}/${input.documentId}`;

  // Ordering is deliberate: preserve evidence first (copy + audit row),
  // then mark the document, then remove the original. A failure midway
  // can leave the original in place — never the evidence missing.
  await copyObject({ sourceKey: input.s3Key, destinationKey: quarantineKey });

  await ContentFlagModel.create({
    userId: input.userId,
    courseId: input.courseId,
    documentId: input.documentId,
    provider: 'photodna',
    matchMeta,
    s3QuarantineKey: quarantineKey,
    retentionUntil: new Date(Date.now() + CONTENT_FLAG_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  });

  // Opaque, generic reason — NEVER disclose detection specifics to the
  // uploader (plan §3.5). 'policy' is all any user-facing surface sees.
  await SourceDocumentModel.updateOne(
    { _id: input.documentId },
    { $set: { status: 'rejected', rejectionReason: 'policy' } },
  );

  await deleteObject({ key: input.s3Key });

  // Log line is deliberately as opaque as the rejection reason.
  integrationLog.error(`${HASH_SCREEN_LABEL} match doc=${input.documentId} quarantined — see ContentFlag + L1 runbook`);
  return { screened: true, matched: true, rejectionReason: 'policy' };
};

// ── Public API ─────────────────────────────────────────────

/**
 * Screen a document's images against the provider hash database.
 * Disabled (day one) → `{screened: false}` and the caller proceeds to
 * the omni-moderation backstop. Provider failure → throws (fail closed).
 */
export const hashScreenImages = async (input: HashScreenInput): Promise<HashScreenResult> => {
  if (!isHashScreenEnabled()) return { screened: false };

  for (const image of input.images) {
    const { isMatch, matchMeta } = await matchImage(image);
    if (isMatch) return quarantineMatch(input, matchMeta);
  }
  return { screened: true, matched: false };
};
