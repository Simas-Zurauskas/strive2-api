import crypto from 'node:crypto';
import pLimit from 'p-limit';
import { Types } from 'mongoose';
import CourseModel from '@models/CourseModel';
import SourceDocumentModel, { ISourceDocument } from '@models/SourceDocumentModel';
import SourceDocumentChunkModel, { ISourceDocumentChunk } from '@models/SourceDocumentChunkModel';
import { AppError } from '@middleware/errorMiddleware';
import { captureError } from '@lib/errorReporter';
import { genLog, jobLog } from '@lib/loggers';
import type { LessonProgressEvent } from '@src/types/socketEvents';
import { URL_BLOCKED_BY_RESERVATION, type SourceDocumentStatus } from '@lib/constants';
import {
  extractDocument,
  ExtractionError,
  type ExtractionResult,
} from './documentExtraction';
import {
  enumerateEmbeddedImages,
  moderateImages,
  moderateTextWithAdjudication,
  screenBeforeVision,
  MODERATION_INCONCLUSIVE_REASON,
  ModerationUnavailableError,
} from './documentModeration';
import { hashScreenImages } from './hashScreen';
import {
  assessDocuments,
  toSourceAnalysis,
  type AssessmentDocSummary,
} from './documentAssessment';
import { buildSourceDigest, type DigestDocInput } from './sourceDigestService';
import { indexSourceDocument } from './sourceDocRagService';
import { getObjectBuffer, uploadBuffer } from './s3Service';

/**
 * The `ingest_documents` job body (Phase 4 of course-from-documents,
 * PLAN §3.1 step 3). Free by policy: the job runner explicitly skips
 * `debitActualSpend` for this type (PLAN §3.4) while every paid call in
 * here still records to UsageEvent through the job's usage scope — which
 * is also why EVERYTHING below is awaited, never fire-and-forgotten.
 *
 * Per-document pipeline (fan-out via p-limit(INGEST_DOC_CONCURRENCY)):
 *   parsing → [bytes] → image pre-vision screens → triage extraction →
 *   text moderation (fail closed) → A9 corpus caps → chunk+embed
 *   (wipe-then-write) → per-doc stats + parsed markdown snapshot →
 *   parsed | rejected | failed, each transition emitted as a
 *   `document_status` progress event.
 *
 * Moderation outcome mapping (Phase 3 contract):
 *   - reject with adjudication reason MODERATION_INCONCLUSIVE_REASON ⇒
 *     the doc goes `failed` (RETRYABLE — an adjudicator outage must never
 *     permanently brand educational content);
 *   - any other reject ⇒ `rejected` (terminal) with a category-level
 *     rejectionReason, never content;
 *   - a moderation-provider outage (ModerationUnavailableError) ⇒
 *     `failed` retryable. NEVER pass-through.
 *
 * Idempotency: docs in `uploaded`, `failed` AND stale `parsing` (a
 * crashed run — the per-course job mutex guarantees no live writer) are
 * (re)processed; chunk indexing is wipe-then-write per document, so
 * re-runs converge. Previously-`parsed` docs are NOT re-extracted, but
 * the assessment + digest are recomputed over the WHOLE corpus from the
 * durable chunk rows, so a partial first run heals on retry.
 */

// ── A9 caps (tunable constants) ─────────────────────────

export const INGEST_DOC_CONCURRENCY = 2;
export const MAX_CORPUS_PAGES = 300;
export const MAX_CORPUS_TOKENS = 600_000;
export const MAX_VISION_PAGES_PER_COURSE = 100;
/** Enforced in the ingest controller (JobModel-counted, ~24h window). */
export const MAX_INGEST_RUNS_PER_DAY = 3;

/** Doc statuses the ingest run picks up (see idempotency note above). */
export const INGESTABLE_STATUSES: SourceDocumentStatus[] = ['uploaded', 'failed', 'parsing'];

// ── Mime families ───────────────────────────────────────

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif']);

const ZIP_CONTAINER_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/epub+zip',
]);

// ── Types ───────────────────────────────────────────────

export interface RunIngestParams {
  courseId: string;
  userId: string;
  /** Fan-out sink for `document_status` progress events (jobRunner wires it to jobEvents). */
  emitProgress: (event: LessonProgressEvent) => void;
}

type DocOutcome = 'parsed' | 'rejected' | 'failed' | 'skipped';

interface ProcessDocResult {
  outcome: DocOutcome;
}

// ── Helpers ─────────────────────────────────────────────

const sha256Hex = (buffer: Buffer): string => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Read the reservation audit pair off a blocked-URL `ExtractionError`.
 * `meta` is an untyped bag by design, so both fields are read defensively:
 * a missing signal must not lose the rejection, only the audit detail.
 */
const readReservationAudit = (
  meta: Record<string, unknown> | undefined,
): { signal?: string; checkedAt?: Date } => ({
  ...(typeof meta?.signal === 'string' ? { signal: meta.signal } : {}),
  ...(meta?.checkedAt instanceof Date ? { checkedAt: meta.checkedAt } : {}),
});

/** Tokens ≈ chars/4 — the same estimate the rest of the repo uses. */
const estimateTokens = (markdown: string): number => Math.ceil(markdown.length / 4);

/**
 * Escalated-page resume markers — the union of two signals, both scoped to
 * pages the extractor reported as SCANNED (a page that never needed vision
 * is never marked):
 *
 *   (a) `visionAttemptedPages` — pages actually SENT to the vision provider
 *       on this run. This is the authoritative "work was done and paid for"
 *       signal, and it is what makes a FULLY BLANK scanned page count as
 *       escalated: it emits no block, so (b) cannot see it, and without (a)
 *       `scannedPageCount > escalatedPages.length` stayed true forever and
 *       re-fired a paid no-op `prepare_corpus` on every structure attempt
 *       (observed 2026-07-30: `escalatedTotal=1` with 5 pages outstanding).
 *       Re-sending a page that came back blank buys nothing — the same
 *       bytes produce the same nothing.
 *
 *   (b) block page-ranges — a scanned page covered by any emitted block was
 *       (at least partially) transcribed. Kept because it is the only
 *       signal for extractors that produce page-ranged blocks without a
 *       vision call, and because it stays correct when a later vision batch
 *       throws and (a) is therefore not reported at all.
 *
 * Conservative in the direction that matters (the Phase-5 marker intent):
 * pages vision never attempted stay OUTSTANDING, so a budget-truncated or
 * provider-failed run is retried rather than silently written off; and a
 * page that yielded only tier-0 crumbs may be redone by `prepare_corpus`,
 * which is cheap and safe. Exported for reuse by corpusPreparationService
 * (the same marker semantics on the full-extraction pass).
 */
export const deriveEscalatedPages = (extraction: ExtractionResult): number[] => {
  const scanned = new Set(extraction.scannedPages ?? []);
  if (scanned.size === 0) return [];
  const escalated = new Set<number>();
  for (const page of extraction.visionAttemptedPages ?? []) {
    if (scanned.has(page)) escalated.add(page);
  }
  for (const block of extraction.blocks) {
    if (!block.pageRange) continue;
    for (let p = block.pageRange.start; p <= block.pageRange.end; p++) {
      if (scanned.has(p)) escalated.add(p);
    }
  }
  return [...escalated].sort((a, b) => a - b);
};

// ── The run ─────────────────────────────────────────────

export const runIngestDocuments = async ({ courseId, userId, emitProgress }: RunIngestParams): Promise<void> => {
  const courseObjectId = new Types.ObjectId(courseId);

  const emitDocStatus = (documentId: string, status: SourceDocumentStatus, warnings?: string[]) => {
    emitProgress({
      type: 'document_status',
      documentId,
      status,
      ...(warnings && warnings.length > 0 ? { warnings } : {}),
    });
  };

  const setDocStatus = async (
    documentId: Types.ObjectId,
    status: SourceDocumentStatus,
    fields: Partial<ISourceDocument> = {},
  ) => {
    // Plain by-id write: the per-course job mutex serializes ingest runs
    // and the upload surface 409s while a job is active, so there is no
    // competing writer for these rows during a run.
    await SourceDocumentModel.updateOne({ _id: documentId }, { $set: { status, ...fields } });
    emitDocStatus(documentId.toString(), status, (fields.warnings as string[] | undefined) ?? undefined);
  };

  const docs = await SourceDocumentModel.find({
    courseId: courseObjectId,
    status: { $in: INGESTABLE_STATUSES },
  }).sort({ createdAt: 1, _id: 1 });

  const previouslyParsed = await SourceDocumentModel.find({
    courseId: courseObjectId,
    status: 'parsed',
  }).lean();

  // Running corpus totals seeded from already-parsed documents so re-runs
  // and incremental uploads share one budget (A9). JS is single-threaded:
  // each check+commit below happens synchronously between awaits, so the
  // p-limit(2) fan-out cannot double-spend a budget slot; the one residual
  // window (two docs extracting concurrently, both under-budget at start)
  // over-runs by at most one document and is then caught by the post-
  // extraction check, which fails the later committer.
  let totalPages = previouslyParsed.reduce((sum, d) => sum + (d.pageCount ?? 0), 0);
  let totalTokens = previouslyParsed.reduce((sum, d) => sum + (d.extractedTokens ?? 0), 0);
  let escalatedTotal =
    previouslyParsed.reduce((sum, d) => sum + (d.escalatedPages?.length ?? 0), 0) +
    docs.reduce((sum, d) => sum + (d.escalatedPages?.length ?? 0), 0);
  let capsExhausted = totalPages >= MAX_CORPUS_PAGES || totalTokens >= MAX_CORPUS_TOKENS;
  let skippedByCaps = 0;
  const courseWarnings = new Set<string>();

  const capWarning = () =>
    `Corpus limits reached (max ${MAX_CORPUS_PAGES} pages / ~${Math.round(MAX_CORPUS_TOKENS / 1000)}k tokens per course) — ${skippedByCaps} document(s) were not ingested. Remove or split documents and re-run.`;

  // ── Per-document pipeline ─────────────────────────────

  const processDoc = async (doc: (typeof docs)[number]): Promise<ProcessDocResult> => {
    const documentId = doc._id as Types.ObjectId;
    const docTag = `course=${courseId} doc=${documentId.toString()}`;
    const docWarnings: string[] = [];

    // Course-level cap pre-check: once the budget is spent, later docs are
    // left untouched (still uploaded/failed) so the user can re-run after
    // trimming the corpus.
    if (capsExhausted) {
      skippedByCaps += 1;
      courseWarnings.add(capWarning());
      return { outcome: 'skipped' };
    }

    try {
      await setDocStatus(documentId, 'parsing');

      let extraction: ExtractionResult;

      if (doc.kind === 'url') {
        // URL: fetched via the Jina path inside extractDocument; the
        // returned markdown IS the snapshot — persist it at the doc's
        // reserved key so provenance survives the page changing later.
        extraction = await extractDocument(
          {
            buffer: Buffer.alloc(0),
            mimeType: 'text/html',
            filename: doc.filename,
            kind: 'url',
            sourceUrl: doc.sourceUrl ?? undefined,
          },
          { mode: 'triage' },
        );
        const snapshot = Buffer.from(extraction.markdown, 'utf-8');
        await uploadBuffer({ key: doc.s3Key, body: snapshot, contentType: 'text/markdown' });
        await SourceDocumentModel.updateOne(
          { _id: documentId },
          {
            $set: {
              sha256: sha256Hex(snapshot),
              byteSize: snapshot.length,
              // Audit trail: which rights reservation we honoured at fetch
              // time. Without it we cannot later PROVE we honoured one.
              ...(extraction.reservation
                ? {
                    reservationSignal: extraction.reservation.signal,
                    reservationCheckedAt: extraction.reservation.checkedAt,
                  }
                : {}),
            },
          },
        );
      } else {
        const buffer = await getObjectBuffer({ key: doc.s3Key });
        const mime = doc.mimeType.toLowerCase();

        if (IMAGE_MIMES.has(mime)) {
          // Standalone image: hash screen FIRST (no-op until PhotoDNA keys
          // exist; throws ⇒ this doc fails closed, retryable), then
          // moderation-before-vision via screenBeforeVision — vision runs
          // ONLY inside the wrapper, only on a pass verdict, and over-20MB
          // (unscreenable) images never reach it.
          const hs = await hashScreenImages({
            images: [{ buffer, mimeType: mime }],
            userId,
            courseId,
            documentId: documentId.toString(),
            s3Key: doc.s3Key,
          });
          if (hs.screened && hs.matched) {
            // hashScreen already quarantined + marked the row rejected.
            emitDocStatus(documentId.toString(), 'rejected');
            return { outcome: 'rejected' };
          }

          const { verdict, visionResult } = await screenBeforeVision(
            [{ buffer, mimeType: mime }],
            { courseId, documentId: documentId.toString(), label: 'doc:ingest' },
            async (cleared) => {
              if (cleared.length === 0) return null; // unscreened bytes never reach vision
              return extractDocument(
                { buffer: cleared[0].buffer, mimeType: mime, filename: doc.filename, kind: 'file' },
                { mode: 'triage' },
              );
            },
          );
          docWarnings.push(...verdict.warnings);
          if (verdict.decision === 'reject') {
            await setDocStatus(documentId, 'rejected', {
              rejectionReason: verdict.categories.join(', ') || 'policy',
              warnings: docWarnings,
            });
            return { outcome: 'rejected' };
          }
          if (verdict.decision !== 'pass' || !visionResult) {
            // Mid-band or unscreenable: the image is simply not escalated —
            // with no other content channel, the doc fails retryable.
            docWarnings.push('image could not be cleared for processing');
            await setDocStatus(documentId, 'failed', { warnings: docWarnings });
            return { outcome: 'failed' };
          }
          extraction = visionResult;
        } else if (ZIP_CONTAINER_MIMES.has(mime)) {
          // Zip-container doc: enumerate + screen the embedded images
          // (moderation is free; these images are NEVER sent to vision, so
          // this is purely a policy screen). Throws zip_bomb/zip_invalid ⇒
          // the ExtractionError catch below fails the doc.
          const { images, warnings: enumWarnings } = enumerateEmbeddedImages(buffer, doc.mimeType);
          docWarnings.push(...enumWarnings);
          if (images.length > 0) {
            const hs = await hashScreenImages({
              images,
              userId,
              courseId,
              documentId: documentId.toString(),
              s3Key: doc.s3Key,
            });
            if (hs.screened && hs.matched) {
              emitDocStatus(documentId.toString(), 'rejected');
              return { outcome: 'rejected' };
            }
            const imageVerdict = await moderateImages(images, {
              courseId,
              documentId: documentId.toString(),
              label: 'doc:ingest',
            });
            docWarnings.push(...imageVerdict.warnings);
            if (imageVerdict.decision === 'reject') {
              await setDocStatus(documentId, 'rejected', {
                rejectionReason: imageVerdict.categories.join(', ') || 'policy',
                warnings: docWarnings,
              });
              return { outcome: 'rejected' };
            }
            if (imageVerdict.decision === 'adjudicate') {
              // Mid-band on embedded images: log-and-continue — the text
              // screen below still gates the document (conservative-block
              // policy: hard-reject bands only).
              docWarnings.push('embedded images were flagged mid-band by moderation');
            }
          }
          extraction = await extractDocument(
            { buffer, mimeType: doc.mimeType, filename: doc.filename, kind: 'file' },
            { mode: 'triage' },
          );
        } else {
          // PDF / text / csv / html / audio. Scanned-PDF interiors cannot be
          // image-moderated pre-vision (no page renderer — documented Phase 3
          // limitation); coverage there is (i) text moderation of everything
          // vision returns, below, and (ii) Anthropic's own abuse filters on
          // the uploaded PDF document block.
          const visionPageBudget = Math.max(0, MAX_VISION_PAGES_PER_COURSE - escalatedTotal);
          extraction = await extractDocument(
            { buffer, mimeType: doc.mimeType, filename: doc.filename, kind: 'file' },
            { mode: 'triage', visionPageBudget },
          );
        }
      }

      docWarnings.push(...extraction.warnings);

      // ── Text moderation (full extracted text, batched) — fail closed ──
      const moderation = await moderateTextWithAdjudication(
        extraction.blocks.map((b) => b.markdown),
        { courseId, documentId: documentId.toString(), label: 'doc:ingest' },
      );
      docWarnings.push(...moderation.warnings);
      if (moderation.decision === 'reject') {
        if (moderation.adjudication?.reason === MODERATION_INCONCLUSIVE_REASON) {
          // Inconclusive adjudication says nothing about the content —
          // retryable `failed`, never a terminal brand (Phase 3 contract).
          docWarnings.push('moderation was inconclusive — try running ingest again');
          await setDocStatus(documentId, 'failed', { warnings: docWarnings });
          return { outcome: 'failed' };
        }
        await setDocStatus(documentId, 'rejected', {
          rejectionReason: moderation.categories.join(', ') || 'policy',
          warnings: docWarnings,
        });
        return { outcome: 'rejected' };
      }

      // ── A9 corpus caps (post-extraction commit) ──
      const docPages = extraction.pageCount ?? 0;
      const docTokens = estimateTokens(extraction.markdown);
      if (totalPages + docPages > MAX_CORPUS_PAGES || totalTokens + docTokens > MAX_CORPUS_TOKENS) {
        capsExhausted = true;
        docWarnings.push(
          `document exceeds the course corpus limit (${MAX_CORPUS_PAGES} pages / ~${Math.round(MAX_CORPUS_TOKENS / 1000)}k tokens) — not ingested (DOCUMENT_LIMIT_EXCEEDED)`,
        );
        await setDocStatus(documentId, 'failed', { warnings: docWarnings });
        return { outcome: 'failed' };
      }
      totalPages += docPages;
      totalTokens += docTokens;

      // ── Chunk + embed (wipe-then-write inside) ──
      const indexResult = await indexSourceDocument({
        userId,
        courseId,
        documentId: documentId.toString(),
        blocks: extraction.blocks,
      });
      if (!indexResult.ok) {
        // Roll the budget commitment back — this doc contributed nothing.
        totalPages -= docPages;
        totalTokens -= docTokens;
        docWarnings.push(`indexing failed (${indexResult.reason ?? 'unknown'}) — try running ingest again`);
        await setDocStatus(documentId, 'failed', { warnings: docWarnings });
        return { outcome: 'failed' };
      }

      // ── Per-doc stats + parsed-markdown snapshot ──
      const escalatedPages = [...new Set([...(doc.escalatedPages ?? []), ...deriveEscalatedPages(extraction)])].sort(
        (a, b) => a - b,
      );
      escalatedTotal += escalatedPages.length - (doc.escalatedPages?.length ?? 0);

      // Parsed artifact pinned INSIDE the course prefix (plan §3.3) so the
      // existing prefix-delete erasure covers it. Content-hashed within the
      // course only — never cross-user.
      let parsedS3Key: string | null = `uploads/${userId}/${courseId}/parsed/${sha256Hex(Buffer.from(extraction.markdown, 'utf-8'))}`;
      try {
        await uploadBuffer({ key: parsedS3Key, body: Buffer.from(extraction.markdown, 'utf-8'), contentType: 'text/markdown' });
      } catch (e) {
        // Provenance artifact only — chunks are already durable; degrade
        // with a warning rather than failing the parsed document.
        genLog.warn(`doc:ingest parsed-snapshot upload failed ${docTag}: ${(e as Error).message}`);
        docWarnings.push('parsed snapshot could not be stored');
        parsedS3Key = null;
      }

      await setDocStatus(documentId, 'parsed', {
        rejectionReason: null,
        pageCount: extraction.pageCount ?? null,
        extractedTokens: docTokens,
        scannedPageCount: extraction.scannedPages?.length ?? null,
        escalatedPages,
        audioDurationSec: extraction.audioDurationSec ?? null,
        transcribedSec: extraction.transcribedSec ?? null,
        parsedS3Key,
        warnings: docWarnings,
      });
      return { outcome: 'parsed' };
    } catch (err) {
      if (err instanceof ExtractionError && err.reason === URL_BLOCKED_BY_RESERVATION) {
        // Rights reservation: TERMINAL, not retryable — the answer will not
        // change on a re-run, and re-running would re-hit the source. The
        // document is rejected with a category-level reason plus the audit
        // pair; every sibling document in the corpus carries on parsing.
        const audit = readReservationAudit(err.meta);
        docWarnings.push(
          'this link could not be used: the site asks automated systems not to use it, or its rules could not be read',
        );
        await setDocStatus(documentId, 'rejected', {
          rejectionReason: URL_BLOCKED_BY_RESERVATION,
          ...(audit.signal ? { reservationSignal: audit.signal } : {}),
          ...(audit.checkedAt ? { reservationCheckedAt: audit.checkedAt } : {}),
          warnings: docWarnings,
        });
        return { outcome: 'rejected' };
      }
      if (err instanceof ExtractionError) {
        docWarnings.push(`extraction failed: ${err.reason}`);
      } else if (err instanceof ModerationUnavailableError) {
        docWarnings.push('moderation is temporarily unavailable — try running ingest again');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        jobLog.error(`doc:ingest doc-failed ${docTag} msg=${message.slice(0, 300)}`);
        captureError(err, { tags: { source: 'documentIngest' }, extra: { courseId, documentId: documentId.toString() } });
        docWarnings.push('processing failed — try running ingest again');
      }
      await setDocStatus(documentId, 'failed', { warnings: docWarnings }).catch(() => {
        // Status write failed too — the doc stays `parsing` and the next
        // run picks it up via INGESTABLE_STATUSES (crashed-run semantics).
      });
      return { outcome: 'failed' };
    }
  };

  const limit = pLimit(INGEST_DOC_CONCURRENCY);
  const outcomes = await Promise.all(docs.map((doc) => limit(() => processDoc(doc))));

  jobLog.info(
    `doc:ingest fan-out done course=${courseId} docs=${docs.length} parsed=${outcomes.filter((o) => o.outcome === 'parsed').length} rejected=${outcomes.filter((o) => o.outcome === 'rejected').length} failed=${outcomes.filter((o) => o.outcome === 'failed').length} skipped=${skippedByCaps} pages=${totalPages} tokens=${totalTokens}`,
  );

  // ── Corpus-level: assessment + digest over the durable rows ──

  const allDocs = await SourceDocumentModel.find({ courseId: courseObjectId }).sort({ createdAt: 1, _id: 1 }).lean();
  const parsedDocs = allDocs.filter((d) => d.status === 'parsed');

  if (parsedDocs.length === 0) {
    const rejected = allDocs.filter((d) => d.status === 'rejected').length;
    const failed = allDocs.filter((d) => d.status === 'failed').length;
    throw new AppError('None of the documents could be used — they were rejected or failed processing.', {
      errorCode: 'CONTENT_REJECTED',
      statusCode: 400,
      meta: { rejected, failed },
    });
  }

  // Durable truth: summaries + digest inputs come from the persisted chunk
  // rows, uniformly for this run's docs and previously-parsed ones — which
  // is what makes a partial run heal on retry.
  const chunkRows = await SourceDocumentChunkModel.find({ courseId: courseObjectId })
    .sort({ documentId: 1, chunkIndex: 1 })
    .lean();
  const chunksByDoc = new Map<string, (ISourceDocumentChunk & { _id: Types.ObjectId })[]>();
  for (const row of chunkRows) {
    const key = row.documentId.toString();
    const list = chunksByDoc.get(key) ?? [];
    list.push(row);
    chunksByDoc.set(key, list);
  }

  const perDocSummaries: AssessmentDocSummary[] = allDocs.map((d) => {
    const docChunks = d.status === 'parsed' ? (chunksByDoc.get(d._id.toString()) ?? []) : [];
    let sample = '';
    for (const c of docChunks) {
      if (sample.length >= 6_000) break;
      sample += (sample ? '\n\n' : '') + c.text;
    }
    const headingOutline = [...new Set(docChunks.map((c) => c.headingPath.join(' > ')).filter(Boolean))].slice(0, 40);
    return {
      documentId: d._id.toString(),
      filename: d.filename,
      blocksSample: sample.slice(0, 6_000),
      headingOutline,
      counts: {
        blocks: docChunks.length,
        tokens: d.extractedTokens ?? 0,
        ...(d.pageCount ? { pages: d.pageCount } : {}),
      },
      status: d.status,
      rejectionReason: d.rejectionReason,
      warnings: d.warnings,
    };
  });

  const verdict = await assessDocuments({ perDocSummaries, totalTokens });
  // Server-only risk scores steer policy/ops only — logged, NEVER persisted
  // into the client-visible assessment (A10; toSourceAnalysis is the wall).
  genLog.info(
    `doc:ingest risk course=${courseId} class="${verdict.contentClass}" edu=${verdict.educationalIntent} injection=${verdict.injectionSuspicion} pii=${verdict.piiDensity} copyright=${verdict.copyrightSuspicion}`,
  );

  const analysis = toSourceAnalysis(verdict);
  const analysisWarnings = [...analysis.warnings, ...courseWarnings];
  await CourseModel.findByIdAndUpdate(courseId, {
    sourceAssessment: { ...analysis, warnings: analysisWarnings },
  });

  const digestInputs: DigestDocInput[] = parsedDocs.map((d) => ({
    documentId: d._id.toString(),
    filename: d.filename,
    chunks: (chunksByDoc.get(d._id.toString()) ?? []).map((c) => ({
      vectorId: c.vectorId,
      text: c.text,
      headingPath: c.headingPath,
    })),
  }));
  const digest = await buildSourceDigest(digestInputs);
  await CourseModel.findByIdAndUpdate(courseId, { sourceDigest: digest });

  // NOTE deliberately absent: `verdict.suggestedGoal` is NOT applied to
  // `course.goal` — the user confirms/edits it in the wizard via PATCH
  // (Phase 6). The suggestion travels only inside sourceAssessment.

  jobLog.info(
    `doc:ingest done course=${courseId} parsed=${parsedDocs.length}/${allDocs.length} digestTopics=${digest.topics.length}`,
  );
};
