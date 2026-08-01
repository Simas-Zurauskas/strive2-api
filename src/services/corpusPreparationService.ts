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
import type { SourceDocumentStatus } from '@lib/constants';
import { extractDocument, ExtractionError, type ExtractionResult } from './documentExtraction';
import {
  moderateTextWithAdjudication,
  MODERATION_INCONCLUSIVE_REASON,
  ModerationUnavailableError,
} from './documentModeration';
import {
  deriveEscalatedPages,
  INGEST_DOC_CONCURRENCY,
  MAX_VISION_PAGES_PER_COURSE,
} from './documentIngestService';
import { buildSourceDigest, type DigestDocInput } from './sourceDigestService';
import { indexSourceDocument } from './sourceDocRagService';
import { getObjectBuffer, uploadBuffer } from './s3Service';

/**
 * The `prepare_corpus` job body (Phase 5 of course-from-documents, PLAN
 * §3.1 step 5 + §3.4). DEBITED — unlike `ingest_documents`, this type
 * takes the normal debit-on-success path in jobRunner (only ingest is
 * exempt), so a successful run charges the real accumulated vendor spend
 * and a failed run charges NOTHING. That failure semantics is the plan's
 * refund rule in disguise: any moderation reject (or any doc-level
 * failure) fails the whole job BEFORE the success-path debit, so the user
 * is never charged for work whose output was not consumed.
 *
 * What it completes, per parsed document with outstanding paid work:
 *   - scanned PDF pages beyond the triage sample (`scannedPageCount >
 *     escalatedPages.length`) → full vision escalation, bounded by the
 *     remaining course-lifetime vision budget (A9: ≤100 pages);
 *   - audio beyond the free triage window (`transcribedSec <
 *     audioDurationSec`) → full transcription (mp3/m4a triage already
 *     transcribed whole files — those show `transcribedSec ===
 *     audioDurationSec` and are skipped; only sliced wav has a remainder).
 *
 * Ordering invariant (PLAN §3.1 step 5): `moderateTextWithAdjudication`
 * runs over ALL freshly-extracted text BEFORE any chunk/embed/digest-merge
 * for that document. Moderation outcome mapping is byte-for-byte the
 * documentIngestService contract:
 *   - reject with MODERATION_INCONCLUSIVE_REASON ⇒ doc `failed`
 *     (retryable — an adjudicator outage never brands content);
 *   - any other reject ⇒ doc `rejected` (terminal, category-level reason)
 *     and the JOB fails with CONTENT_REJECTED + meta;
 *   - ModerationUnavailableError ⇒ doc `failed` retryable. Never
 *     pass-through.
 *
 * Digest-refresh-only decision (recorded): on success the sourceDigest is
 * rebuilt from the durable chunk rows, but `sourceAssessment` deliberately
 * KEEPS the ingest-time verdict. The coarse assessment (topics, size band,
 * suggested goal, questions) is the wizard-facing product surface and was
 * computed over a representative triage sample; full extraction deepens
 * the retrieval corpus and the digest spans, it does not change what the
 * corpus is about. Re-running the assessment here would also re-open the
 * suggested-goal/questions surface after the user already confirmed them.
 *
 * Corpus caps decision (recorded): the A9 page/token caps are NOT
 * re-enforced here. They gated admission at ingest; the only new text this
 * pass can add is bounded by the vision-page budget (≤100 pages/course)
 * and the ≤180-min audio cap enforced at upload, and failing an
 * already-admitted document over the delta would strand a course the
 * product accepted.
 *
 * Idempotency: outstanding work is detected from the durable resume
 * markers (`escalatedPages`, `transcribedSec`), which only advance after a
 * document fully lands (moderated + re-indexed + persisted). A second run
 * with nothing outstanding completes quickly as a no-op (no extraction, no
 * digest rebuild — and therefore a ~zero debit). Chunk indexing is
 * wipe-then-write per document, so re-runs converge.
 *
 * Recovery note: a document this pass marks `failed` is picked up by the
 * (free) ingest job's INGESTABLE_STATUSES, which restores it to `parsed`
 * with triage-level content; `prepare_corpus` then sees its outstanding
 * markers again. This pass itself only touches `parsed` documents.
 */

export interface RunPrepareCorpusParams {
  courseId: string;
  userId: string;
  /** Fan-out sink for `document_status` progress events (jobRunner wires it to jobEvents). */
  emitProgress: (event: LessonProgressEvent) => void;
}

type PrepareOutcome = 'prepared' | 'rejected' | 'failed';

// ── Outstanding-work predicates (also the client's "needs preparation" rule) ──

export const hasOutstandingScannedWork = (doc: Pick<ISourceDocument, 'scannedPageCount' | 'escalatedPages'>): boolean =>
  (doc.scannedPageCount ?? 0) > (doc.escalatedPages?.length ?? 0);

export const hasOutstandingAudioWork = (doc: Pick<ISourceDocument, 'audioDurationSec' | 'transcribedSec'>): boolean =>
  typeof doc.audioDurationSec === 'number' &&
  doc.audioDurationSec > 0 &&
  (doc.transcribedSec ?? 0) < doc.audioDurationSec;

/** True when the parsed doc still has paid extraction work outstanding. */
export const hasOutstandingPaidWork = (
  doc: Pick<ISourceDocument, 'scannedPageCount' | 'escalatedPages' | 'audioDurationSec' | 'transcribedSec'>,
): boolean => hasOutstandingScannedWork(doc) || hasOutstandingAudioWork(doc);

// ── Helpers ─────────────────────────────────────────────

const sha256Hex = (buffer: Buffer): string => crypto.createHash('sha256').update(buffer).digest('hex');

/** Tokens ≈ chars/4 — the repo-wide estimate (documentIngestService idiom). */
const estimateTokens = (markdown: string): number => Math.ceil(markdown.length / 4);

// ── The run ─────────────────────────────────────────────

export const runPrepareCorpus = async ({ courseId, userId, emitProgress }: RunPrepareCorpusParams): Promise<void> => {
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
    // Plain by-id write — the per-course job mutex serializes runs, same
    // as ingest (no competing writer while this job holds the course).
    await SourceDocumentModel.updateOne({ _id: documentId }, { $set: { status, ...fields } });
    emitDocStatus(documentId.toString(), status, (fields.warnings as string[] | undefined) ?? undefined);
  };

  const allDocs = await SourceDocumentModel.find({ courseId: courseObjectId }).sort({ createdAt: 1, _id: 1 });
  const outstanding = allDocs.filter((d) => d.status === 'parsed' && d.kind === 'file' && hasOutstandingPaidWork(d));

  if (outstanding.length === 0) {
    // Idempotent no-op: nothing outstanding ⇒ complete quickly. No digest
    // rebuild (nothing changed) and effectively nothing to debit.
    jobLog.info(`doc:prepare no-op course=${courseId} docs=${allDocs.length} — no outstanding paid work`);
    return;
  }

  // Course-lifetime vision budget: 100 − Σ escalatedPages across ALL docs
  // (the ingest reservation pattern). JS is single-threaded, so each
  // read-budget/commit pair below runs synchronously between awaits; the
  // p-limit(2) fan-out can over-run by at most one in-flight document,
  // which the per-call budget inside extractDocument still bounds.
  let escalatedTotal = allDocs.reduce((sum, d) => sum + (d.escalatedPages?.length ?? 0), 0);

  const processDoc = async (doc: (typeof outstanding)[number]): Promise<PrepareOutcome> => {
    const documentId = doc._id as Types.ObjectId;
    const docTag = `course=${courseId} doc=${documentId.toString()}`;
    const docWarnings: string[] = [];

    try {
      await setDocStatus(documentId, 'parsing');

      const buffer = await getObjectBuffer({ key: doc.s3Key });
      const visionPageBudget = Math.max(0, MAX_VISION_PAGES_PER_COURSE - escalatedTotal);

      // FULL extraction: all scanned pages (budget-capped) + whole-file
      // audio transcription (full mode ignores the triage seconds window).
      const extraction: ExtractionResult = await extractDocument(
        { buffer, mimeType: doc.mimeType, filename: doc.filename, kind: 'file' },
        { mode: 'full', visionPageBudget },
      );
      docWarnings.push(...extraction.warnings);

      // ── Moderation of ALL freshly-extracted text BEFORE chunk/embed/
      // digest-merge — the load-bearing ordering (PLAN §3.1 step 5). The
      // full pass covers the previously-unsampled scanned pages and audio
      // tail; outcome mapping is the exact documentIngestService contract.
      const moderation = await moderateTextWithAdjudication(
        extraction.blocks.map((b) => b.markdown),
        { courseId, documentId: documentId.toString(), label: 'doc:prepare' },
      );
      docWarnings.push(...moderation.warnings);
      if (moderation.decision === 'reject') {
        if (moderation.adjudication?.reason === MODERATION_INCONCLUSIVE_REASON) {
          // Inconclusive adjudication says nothing about the content —
          // retryable `failed`, never a terminal brand (Phase 3 contract).
          // Markers NOT advanced: the work was not consumed.
          docWarnings.push('moderation was inconclusive — try preparing the sources again');
          await setDocStatus(documentId, 'failed', { warnings: docWarnings });
          return 'failed';
        }
        await setDocStatus(documentId, 'rejected', {
          rejectionReason: moderation.categories.join(', ') || 'policy',
          warnings: docWarnings,
        });
        return 'rejected';
      }

      // ── Re-index (wipe-then-write inside): triage chunks replaced by the
      // full-extraction chunk set for this document. Only AFTER moderation.
      const indexResult = await indexSourceDocument({
        userId,
        courseId,
        documentId: documentId.toString(),
        blocks: extraction.blocks,
      });
      if (!indexResult.ok) {
        docWarnings.push(`indexing failed (${indexResult.reason ?? 'unknown'}) — try preparing the sources again`);
        await setDocStatus(documentId, 'failed', { warnings: docWarnings });
        return 'failed';
      }

      // ── Advance the resume markers + per-doc stats, only now that the
      // extracted content is moderated AND durably indexed.
      const escalatedPages = [...new Set([...(doc.escalatedPages ?? []), ...deriveEscalatedPages(extraction)])].sort(
        (a, b) => a - b,
      );
      escalatedTotal += escalatedPages.length - (doc.escalatedPages?.length ?? 0);

      // Refresh the parsed-markdown snapshot (course-prefix-pinned so the
      // existing prefix-delete erasure covers it — the ingest idiom).
      let parsedS3Key: string | null = `uploads/${userId}/${courseId}/parsed/${sha256Hex(Buffer.from(extraction.markdown, 'utf-8'))}`;
      try {
        await uploadBuffer({ key: parsedS3Key, body: Buffer.from(extraction.markdown, 'utf-8'), contentType: 'text/markdown' });
      } catch (e) {
        // Provenance artifact only — chunks are already durable; degrade
        // with a warning, keep the previous snapshot key.
        genLog.warn(`doc:prepare parsed-snapshot upload failed ${docTag}: ${(e as Error).message}`);
        docWarnings.push('parsed snapshot could not be stored');
        parsedS3Key = doc.parsedS3Key ?? null;
      }

      await setDocStatus(documentId, 'parsed', {
        rejectionReason: null,
        pageCount: extraction.pageCount ?? doc.pageCount ?? null,
        extractedTokens: estimateTokens(extraction.markdown),
        scannedPageCount: extraction.scannedPages?.length ?? doc.scannedPageCount ?? null,
        escalatedPages,
        audioDurationSec: extraction.audioDurationSec ?? doc.audioDurationSec ?? null,
        transcribedSec: extraction.transcribedSec ?? doc.transcribedSec ?? null,
        parsedS3Key,
        warnings: docWarnings,
      });
      return 'prepared';
    } catch (err) {
      if (err instanceof ExtractionError) {
        docWarnings.push(`extraction failed: ${err.reason}`);
      } else if (err instanceof ModerationUnavailableError) {
        docWarnings.push('moderation is temporarily unavailable — try preparing the sources again');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        jobLog.error(`doc:prepare doc-failed ${docTag} msg=${message.slice(0, 300)}`);
        captureError(err, { tags: { source: 'corpusPreparation' }, extra: { courseId, documentId: documentId.toString() } });
        docWarnings.push('processing failed — try preparing the sources again');
      }
      await setDocStatus(documentId, 'failed', { warnings: docWarnings }).catch(() => {
        // Status write failed too — the doc stays `parsing`; the free
        // ingest run heals it (crashed-run semantics, ingest idiom).
      });
      return 'failed';
    }
  };

  const limit = pLimit(INGEST_DOC_CONCURRENCY);
  const outcomes = await Promise.all(outstanding.map((doc) => limit(() => processDoc(doc))));

  const prepared = outcomes.filter((o) => o === 'prepared').length;
  const rejected = outcomes.filter((o) => o === 'rejected').length;
  const failed = outcomes.filter((o) => o === 'failed').length;
  jobLog.info(
    `doc:prepare fan-out done course=${courseId} outstanding=${outstanding.length} prepared=${prepared} rejected=${rejected} failed=${failed}`,
  );

  // Fail-closed BEFORE the digest rebuild. The job failing here is what
  // keeps the debit at zero (debitActualSpend only runs on job success) —
  // the plan's "nothing debited for unconsumed work" refund rule.
  if (rejected > 0) {
    throw new AppError(
      'Policy-violating content was found in the fully-extracted material. The affected document(s) were rejected.',
      {
        errorCode: 'CONTENT_REJECTED',
        statusCode: 400,
        meta: { rejected, failed, prepared },
      },
    );
  }
  if (failed > 0) {
    // Retryable (no errorCode ⇒ generic retry toast client-side); markers
    // for the failed docs were not advanced, so a re-run redoes them.
    throw new Error(
      `${failed} document(s) failed during corpus preparation — try again. Nothing was charged for this run.`,
    );
  }

  // ── Digest refresh ONLY (see header: sourceAssessment keeps the
  // ingest-time verdict by design). Rebuilt from the durable chunk rows —
  // the same recipe as the ingest tail, over the now-complete corpus.
  const parsedDocs = await SourceDocumentModel.find({ courseId: courseObjectId, status: 'parsed' })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
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

  jobLog.info(
    `doc:prepare done course=${courseId} prepared=${prepared} digestTopics=${digest.topics.length} escalatedTotal=${escalatedTotal}`,
  );
};
