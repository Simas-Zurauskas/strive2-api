/**
 * Tests for the prepare_corpus job body (Phase 5 of course-from-documents,
 * PLAN §3.1 step 5 + §3.4). Providers (extraction, moderation, digest,
 * RAG indexing, S3) are mocked; Mongo is real (memory server).
 *
 * Pins:
 *   - outstanding-work detection: scanned surplus / audio tail / neither,
 *     url docs and non-parsed docs excluded;
 *   - moderation runs BEFORE chunk/embed (call ordering) and its outcome
 *     mapping: terminal reject ⇒ doc `rejected` + job CONTENT_REJECTED
 *     with meta and markers NOT advanced; inconclusive adjudication ⇒ doc
 *     `failed` retryable (plain error, no CONTENT_REJECTED);
 *   - vision budget math: extractDocument receives mode 'full' and
 *     visionPageBudget = 100 − Σ escalatedPages across ALL course docs;
 *   - idempotency: after a successful run advances the markers, a second
 *     run is a no-op (no extraction, no digest rebuild);
 *   - digest-refresh-only: sourceAssessment is never touched.
 *
 * Run: yarn test corpusPreparationService
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, CourseModel } from '../../test-helpers/factories';
import SourceDocumentModel from '@models/SourceDocumentModel';
import type { LessonProgressEvent } from '@src/types/socketEvents';
import { AppError } from '@middleware/errorMiddleware';

const {
  extractDocumentMock,
  moderateTextMock,
  buildSourceDigestMock,
  indexSourceDocumentMock,
  getObjectBufferMock,
  uploadBufferMock,
} = vi.hoisted(() => ({
  extractDocumentMock: vi.fn(),
  moderateTextMock: vi.fn(),
  buildSourceDigestMock: vi.fn(),
  indexSourceDocumentMock: vi.fn(),
  getObjectBufferMock: vi.fn(),
  uploadBufferMock: vi.fn(),
}));

vi.mock('./documentExtraction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./documentExtraction')>();
  return { ...actual, extractDocument: extractDocumentMock };
});

vi.mock('./documentModeration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./documentModeration')>();
  return { ...actual, moderateTextWithAdjudication: moderateTextMock };
});

vi.mock('./sourceDigestService', () => ({
  buildSourceDigest: buildSourceDigestMock,
  DigestFailedError: class DigestFailedError extends Error {},
}));

vi.mock('./sourceDocRagService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sourceDocRagService')>();
  return { ...actual, indexSourceDocument: indexSourceDocumentMock };
});

vi.mock('./s3Service', () => ({
  getObjectBuffer: getObjectBufferMock,
  uploadBuffer: uploadBufferMock,
  deleteByPrefix: vi.fn(() => Promise.resolve(0)),
  getPresignedUrl: vi.fn(),
  objectExists: vi.fn(),
  copyObject: vi.fn(),
  deleteObject: vi.fn(),
  listKeysByPrefix: vi.fn(() => Promise.resolve([])),
}));

import {
  runPrepareCorpus,
  hasOutstandingScannedWork,
  hasOutstandingAudioWork,
  hasOutstandingPaidWork,
} from './corpusPreparationService';
import { MODERATION_INCONCLUSIVE_REASON } from './documentModeration';
import { MAX_VISION_PAGES_PER_COURSE } from './documentIngestService';

setupTestDb();

const passOutcome = () => ({ decision: 'pass' as const, categories: [], maxScores: {}, warnings: [], adjudication: null });
const rejectOutcome = () => ({ decision: 'reject' as const, categories: ['violence'], maxScores: {}, warnings: [], adjudication: null });
const inconclusiveOutcome = () => ({
  decision: 'reject' as const,
  categories: [],
  maxScores: {},
  warnings: [],
  adjudication: { reason: MODERATION_INCONCLUSIVE_REASON },
});

/** Full-extraction result covering scanned pages 1..pageCount. */
const fullExtraction = (pageCount: number) => ({
  markdown: 'full text of the scanned document',
  blocks: [
    {
      type: 'text' as const,
      markdown: 'full text of the scanned document',
      headingPath: ['Doc'],
      pageRange: { start: 1, end: pageCount },
    },
  ],
  pageCount,
  scannedPages: Array.from({ length: pageCount }, (_, i) => i + 1),
  warnings: [],
});

/**
 * Full-extraction result where vision WAS attempted on every scanned page
 * but only page 1 came back with text (the rest were blank/unreadable
 * scans) — the BUG-2 shape. `visionAttemptedPages` is the billed-work
 * signal; blocks alone under-report it.
 */
const blankScanExtraction = (pageCount: number, attempted: number[]) => ({
  markdown: 'only page 1 had legible text',
  blocks: [
    {
      type: 'text' as const,
      markdown: 'only page 1 had legible text',
      headingPath: ['Doc'],
      pageRange: { start: 1, end: 1 },
    },
  ],
  pageCount,
  scannedPages: Array.from({ length: pageCount }, (_, i) => i + 1),
  visionAttemptedPages: attempted,
  warnings: [],
});

const seedDoc = async (params: {
  userId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  status?: string;
  kind?: 'file' | 'url';
  scannedPageCount?: number | null;
  escalatedPages?: number[];
  audioDurationSec?: number | null;
  transcribedSec?: number | null;
  mimeType?: string;
}) => {
  const id = new mongoose.Types.ObjectId();
  return SourceDocumentModel.create({
    _id: id,
    userId: params.userId,
    courseId: params.courseId,
    kind: params.kind ?? 'file',
    ...(params.kind === 'url' ? { sourceUrl: 'https://example.com/article' } : {}),
    filename: `doc-${id.toString().slice(-5)}.pdf`,
    mimeType: params.mimeType ?? 'application/pdf',
    byteSize: 100,
    sha256: id.toString().padEnd(64, 'a').slice(0, 64),
    s3Key: `uploads/${params.userId}/${params.courseId}/${id.toString()}`,
    status: params.status ?? 'parsed',
    scannedPageCount: params.scannedPageCount ?? null,
    escalatedPages: params.escalatedPages ?? [],
    audioDurationSec: params.audioDurationSec ?? null,
    transcribedSec: params.transcribedSec ?? null,
  });
};

const seedCourse = async () => {
  const user = await makeUser();
  const course = await makeCourse({ userId: user._id, status: 'creating' });
  await CourseModel.updateOne(
    { _id: course._id },
    { $set: { source: 'documents', sourceAssessment: { topics: ['t'], sizeBand: { minLessons: 3, maxLessons: 6, mode: 'source_only' }, warnings: [] } } },
  );
  return { user, course };
};

const collectEvents = () => {
  const events: LessonProgressEvent[] = [];
  return { events, emitProgress: (e: LessonProgressEvent) => events.push(e) };
};

beforeEach(() => {
  vi.clearAllMocks();
  getObjectBufferMock.mockResolvedValue(Buffer.from('raw-bytes'));
  uploadBufferMock.mockResolvedValue(undefined);
  moderateTextMock.mockResolvedValue(passOutcome());
  indexSourceDocumentMock.mockResolvedValue({ ok: true, chunksWritten: 3 });
  buildSourceDigestMock.mockResolvedValue({ topics: [{ topic: 'rebuilt', spanRefs: [], docIds: [] }] });
});

// ── Outstanding-work predicates ─────────────────────────

describe('outstanding-work detection', () => {
  test('scanned surplus / audio tail / complete matrix', () => {
    expect(hasOutstandingScannedWork({ scannedPageCount: 5, escalatedPages: [1, 2] })).toBe(true);
    expect(hasOutstandingScannedWork({ scannedPageCount: 2, escalatedPages: [1, 2] })).toBe(false);
    expect(hasOutstandingScannedWork({ scannedPageCount: null, escalatedPages: [] })).toBe(false);

    expect(hasOutstandingAudioWork({ audioDurationSec: 1200, transcribedSec: 600 })).toBe(true);
    // mp3/m4a triage transcribed the WHOLE file — equal seconds means done.
    expect(hasOutstandingAudioWork({ audioDurationSec: 900, transcribedSec: 900 })).toBe(false);
    expect(hasOutstandingAudioWork({ audioDurationSec: null, transcribedSec: null })).toBe(false);

    expect(hasOutstandingPaidWork({ scannedPageCount: 0, escalatedPages: [], audioDurationSec: null, transcribedSec: null })).toBe(false);
    expect(hasOutstandingPaidWork({ scannedPageCount: 3, escalatedPages: [1], audioDurationSec: null, transcribedSec: null })).toBe(true);
    expect(hasOutstandingPaidWork({ scannedPageCount: 0, escalatedPages: [], audioDurationSec: 700, transcribedSec: 600 })).toBe(true);
  });

  test('no outstanding work → quick no-op: no extraction, no digest rebuild', async () => {
    const { user, course } = await seedCourse();
    await seedDoc({ userId: user._id, courseId: course._id, scannedPageCount: 2, escalatedPages: [1, 2] });
    await seedDoc({ userId: user._id, courseId: course._id, audioDurationSec: 900, transcribedSec: 900, mimeType: 'audio/mpeg' });
    const { emitProgress } = collectEvents();

    await runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress });

    expect(extractDocumentMock).not.toHaveBeenCalled();
    expect(buildSourceDigestMock).not.toHaveBeenCalled();
  });

  test('url docs and non-parsed docs are never picked up', async () => {
    const { user, course } = await seedCourse();
    // A url doc with (nonsensical) outstanding-looking markers.
    await seedDoc({ userId: user._id, courseId: course._id, kind: 'url', scannedPageCount: 5, escalatedPages: [] });
    // A failed doc with outstanding markers — ingest heals it, not prepare.
    await seedDoc({ userId: user._id, courseId: course._id, status: 'failed', scannedPageCount: 5, escalatedPages: [] });
    const { emitProgress } = collectEvents();

    await runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress });

    expect(extractDocumentMock).not.toHaveBeenCalled();
  });
});

// ── Happy path ──────────────────────────────────────────

describe('full extraction pass', () => {
  test('full mode + budget math + moderation-before-index + marker advance + digest rebuild', async () => {
    const { user, course } = await seedCourse();
    // A completed doc contributes 3 escalated pages to the course total.
    await seedDoc({ userId: user._id, courseId: course._id, scannedPageCount: 3, escalatedPages: [1, 2, 3] });
    // The outstanding doc: 5 scanned, 2 escalated at triage.
    const doc = await seedDoc({ userId: user._id, courseId: course._id, scannedPageCount: 5, escalatedPages: [1, 2] });
    extractDocumentMock.mockResolvedValue(fullExtraction(5));
    const { events, emitProgress } = collectEvents();

    await runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress });

    // mode 'full' + remaining vision budget = 100 − (3 + 2).
    expect(extractDocumentMock).toHaveBeenCalledTimes(1);
    expect(extractDocumentMock.mock.calls[0][1]).toMatchObject({
      mode: 'full',
      visionPageBudget: MAX_VISION_PAGES_PER_COURSE - 5,
    });

    // Moderation ran BEFORE chunk/embed for the doc (the ordering invariant).
    expect(moderateTextMock).toHaveBeenCalledTimes(1);
    expect(indexSourceDocumentMock).toHaveBeenCalledTimes(1);
    expect(moderateTextMock.mock.invocationCallOrder[0]).toBeLessThan(
      indexSourceDocumentMock.mock.invocationCallOrder[0],
    );

    // Markers advanced: all 5 scanned pages now escalated; doc stays parsed.
    const after = await SourceDocumentModel.findById(doc._id).lean();
    expect(after?.status).toBe('parsed');
    expect(after?.escalatedPages).toEqual([1, 2, 3, 4, 5]);
    expect(after?.scannedPageCount).toBe(5);

    // Digest rebuilt; sourceAssessment untouched (digest-refresh-only rule).
    expect(buildSourceDigestMock).toHaveBeenCalledTimes(1);
    const courseAfter = await CourseModel.findById(course._id).lean();
    expect(courseAfter?.sourceDigest).toMatchObject({ topics: [{ topic: 'rebuilt' }] });
    expect(courseAfter?.sourceAssessment).toMatchObject({ sizeBand: { minLessons: 3, maxLessons: 6 } });

    // Per-doc document_status events: parsing → parsed.
    const statuses = events
      .filter((e): e is Extract<LessonProgressEvent, { type: 'document_status' }> => e.type === 'document_status')
      .map((e) => e.status);
    expect(statuses).toEqual(['parsing', 'parsed']);
  });

  test('idempotent second run after markers advanced: no extraction, no digest rebuild', async () => {
    const { user, course } = await seedCourse();
    await seedDoc({ userId: user._id, courseId: course._id, scannedPageCount: 5, escalatedPages: [1, 2] });
    extractDocumentMock.mockResolvedValue(fullExtraction(5));
    const { emitProgress } = collectEvents();

    await runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress });
    expect(extractDocumentMock).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    getObjectBufferMock.mockResolvedValue(Buffer.from('raw-bytes'));
    await runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress });
    expect(extractDocumentMock).not.toHaveBeenCalled();
    expect(buildSourceDigestMock).not.toHaveBeenCalled();
  });

  // ── BUG-2 regression: blank scanned pages must not re-fire prepare ──
  //
  // Observed: `doc:prepare done … escalatedTotal=1` while 5 scanned pages
  // stayed outstanding, so the client's needs-preparation predicate
  // (scannedPageCount > escalatedPages.length) re-fired a paid no-op
  // prepare_corpus on every later structure attempt.
  test('scanned pages that went through vision but yielded NO text still count as escalated (no re-prepare loop)', async () => {
    const { user, course } = await seedCourse();
    const doc = await seedDoc({ userId: user._id, courseId: course._id, scannedPageCount: 5, escalatedPages: [] });
    extractDocumentMock.mockResolvedValue(blankScanExtraction(5, [1, 2, 3, 4, 5]));
    const { emitProgress } = collectEvents();

    await runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress });

    const after = await SourceDocumentModel.findById(doc._id).lean();
    // All 5 pages were SENT to vision (billed) — blank output is still work done.
    expect(after?.escalatedPages).toEqual([1, 2, 3, 4, 5]);
    expect(hasOutstandingScannedWork({
      scannedPageCount: after?.scannedPageCount ?? null,
      escalatedPages: after?.escalatedPages ?? [],
    })).toBe(false);

    // Second run: nothing outstanding ⇒ no extraction, no paid digest rebuild.
    vi.clearAllMocks();
    getObjectBufferMock.mockResolvedValue(Buffer.from('raw-bytes'));
    await runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress });
    expect(extractDocumentMock).not.toHaveBeenCalled();
    expect(buildSourceDigestMock).not.toHaveBeenCalled();
  });

  test('scanned pages never SENT to vision stay outstanding (a second run still picks the doc up)', async () => {
    const { user, course } = await seedCourse();
    const doc = await seedDoc({ userId: user._id, courseId: course._id, scannedPageCount: 5, escalatedPages: [] });
    // Budget/limit stopped vision after 2 of the 5 scanned pages.
    extractDocumentMock.mockResolvedValue(blankScanExtraction(5, [1, 2]));
    const { emitProgress } = collectEvents();

    await runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress });

    const after = await SourceDocumentModel.findById(doc._id).lean();
    expect(after?.escalatedPages).toEqual([1, 2]);
    expect(hasOutstandingScannedWork({
      scannedPageCount: after?.scannedPageCount ?? null,
      escalatedPages: after?.escalatedPages ?? [],
    })).toBe(true);

    vi.clearAllMocks();
    getObjectBufferMock.mockResolvedValue(Buffer.from('raw-bytes'));
    moderateTextMock.mockResolvedValue(passOutcome());
    indexSourceDocumentMock.mockResolvedValue({ ok: true, chunksWritten: 3 });
    buildSourceDigestMock.mockResolvedValue({ topics: [] });
    extractDocumentMock.mockResolvedValue(blankScanExtraction(5, [1, 2, 3, 4, 5]));
    await runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress });
    expect(extractDocumentMock).toHaveBeenCalledTimes(1);
    expect((await SourceDocumentModel.findById(doc._id).lean())?.escalatedPages).toEqual([1, 2, 3, 4, 5]);
  });

  test('audio doc with untranscribed tail is picked up in full mode', async () => {
    const { user, course } = await seedCourse();
    const doc = await seedDoc({
      userId: user._id,
      courseId: course._id,
      mimeType: 'audio/wav',
      audioDurationSec: 1200,
      transcribedSec: 600,
    });
    extractDocumentMock.mockResolvedValue({
      markdown: 'full transcript',
      blocks: [{ type: 'text' as const, markdown: 'full transcript', headingPath: [] }],
      audioDurationSec: 1200,
      transcribedSec: 1200,
      warnings: [],
    });
    const { emitProgress } = collectEvents();

    await runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress });

    expect(extractDocumentMock).toHaveBeenCalledTimes(1);
    expect(extractDocumentMock.mock.calls[0][1]).toMatchObject({ mode: 'full' });
    const after = await SourceDocumentModel.findById(doc._id).lean();
    expect(after?.transcribedSec).toBe(1200);
    expect(after?.status).toBe('parsed');
  });
});

// ── Moderation outcome mapping ──────────────────────────

describe('moderation before merge', () => {
  test('terminal reject ⇒ doc rejected, job CONTENT_REJECTED with meta, markers NOT advanced, nothing indexed', async () => {
    const { user, course } = await seedCourse();
    const doc = await seedDoc({ userId: user._id, courseId: course._id, scannedPageCount: 5, escalatedPages: [1, 2] });
    extractDocumentMock.mockResolvedValue(fullExtraction(5));
    moderateTextMock.mockResolvedValue(rejectOutcome());
    const { emitProgress } = collectEvents();

    const err = await runPrepareCorpus({
      courseId: course._id.toString(),
      userId: user._id.toString(),
      emitProgress,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).errorCode).toBe('CONTENT_REJECTED');
    expect((err as AppError).meta).toMatchObject({ rejected: 1, failed: 0, prepared: 0 });

    // The unconsumed work: nothing merged, markers untouched.
    expect(indexSourceDocumentMock).not.toHaveBeenCalled();
    expect(buildSourceDigestMock).not.toHaveBeenCalled();
    const after = await SourceDocumentModel.findById(doc._id).lean();
    expect(after?.status).toBe('rejected');
    expect(after?.rejectionReason).toBe('violence');
    expect(after?.escalatedPages).toEqual([1, 2]);
  });

  test('inconclusive adjudication ⇒ doc failed retryable, plain error (not CONTENT_REJECTED), markers NOT advanced', async () => {
    const { user, course } = await seedCourse();
    const doc = await seedDoc({ userId: user._id, courseId: course._id, scannedPageCount: 5, escalatedPages: [1, 2] });
    extractDocumentMock.mockResolvedValue(fullExtraction(5));
    moderateTextMock.mockResolvedValue(inconclusiveOutcome());
    const { emitProgress } = collectEvents();

    const err = await runPrepareCorpus({
      courseId: course._id.toString(),
      userId: user._id.toString(),
      emitProgress,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);

    const after = await SourceDocumentModel.findById(doc._id).lean();
    expect(after?.status).toBe('failed');
    expect(after?.escalatedPages).toEqual([1, 2]);
    expect(indexSourceDocumentMock).not.toHaveBeenCalled();
    expect(buildSourceDigestMock).not.toHaveBeenCalled();
  });

  test('indexing failure ⇒ doc failed retryable, job fails, no digest rebuild', async () => {
    const { user, course } = await seedCourse();
    const doc = await seedDoc({ userId: user._id, courseId: course._id, scannedPageCount: 5, escalatedPages: [] });
    extractDocumentMock.mockResolvedValue(fullExtraction(5));
    indexSourceDocumentMock.mockResolvedValue({ ok: false, chunksWritten: 0, reason: 'pinecone_failed' });
    const { emitProgress } = collectEvents();

    await expect(
      runPrepareCorpus({ courseId: course._id.toString(), userId: user._id.toString(), emitProgress }),
    ).rejects.toThrow(/failed during corpus preparation/);

    expect((await SourceDocumentModel.findById(doc._id).lean())?.status).toBe('failed');
    expect(buildSourceDigestMock).not.toHaveBeenCalled();
  });
});
