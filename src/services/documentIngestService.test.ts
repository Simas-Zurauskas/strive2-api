/**
 * Tests for the ingest_documents job body (Phase 4 of course-from-documents,
 * PLAN §3.1 step 3). All providers (extraction, moderation, assessment,
 * digest, RAG indexing, S3) are mocked; Mongo is real (memory server).
 *
 * Pins: the per-document sequence + document_status events, moderation
 * outcome mapping (reject→rejected terminal, inconclusive/outage→failed
 * retryable), the A9 corpus caps (per-doc excess fails the doc, exhausted
 * caps stop further docs), URL snapshot persistence, the image
 * hash-screen→screenBeforeVision ordering, partial-failure continuation,
 * and the all-rejected CONTENT_REJECTED failure with meta counts.
 *
 * Run: yarn test documentIngestService
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, CourseModel } from '../../test-helpers/factories';
import SourceDocumentModel from '@models/SourceDocumentModel';
import type { LessonProgressEvent } from '@src/types/socketEvents';

const {
  extractDocumentMock,
  moderateTextMock,
  moderateImagesMock,
  screenBeforeVisionMock,
  enumerateEmbeddedImagesMock,
  hashScreenImagesMock,
  assessDocumentsMock,
  buildSourceDigestMock,
  indexSourceDocumentMock,
  getObjectBufferMock,
  uploadBufferMock,
} = vi.hoisted(() => ({
  extractDocumentMock: vi.fn(),
  moderateTextMock: vi.fn(),
  moderateImagesMock: vi.fn(),
  screenBeforeVisionMock: vi.fn(),
  enumerateEmbeddedImagesMock: vi.fn(),
  hashScreenImagesMock: vi.fn(),
  assessDocumentsMock: vi.fn(),
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
  return {
    ...actual,
    moderateTextWithAdjudication: moderateTextMock,
    moderateImages: moderateImagesMock,
    screenBeforeVision: screenBeforeVisionMock,
    enumerateEmbeddedImages: enumerateEmbeddedImagesMock,
  };
});

vi.mock('./documentAssessment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./documentAssessment')>();
  return { ...actual, assessDocuments: assessDocumentsMock };
});

vi.mock('./hashScreen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hashScreen')>();
  return { ...actual, hashScreenImages: hashScreenImagesMock };
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

import { runIngestDocuments, deriveEscalatedPages, MAX_CORPUS_PAGES, MAX_CORPUS_TOKENS } from './documentIngestService';
import { ModerationUnavailableError, MODERATION_INCONCLUSIVE_REASON } from './documentModeration';
import { ExtractionError } from './documentExtraction';
import { URL_BLOCKED_BY_RESERVATION } from '@lib/constants';
import { AppError } from '@middleware/errorMiddleware';

setupTestDb();

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const passOutcome = () => ({ decision: 'pass' as const, categories: [], maxScores: {}, warnings: [], adjudication: null });

const extraction = (markdown: string, extra: Record<string, unknown> = {}) => ({
  markdown,
  blocks: [{ type: 'text' as const, markdown, headingPath: ['H1'] }],
  warnings: [],
  ...extra,
});

const baseVerdict = () => ({
  contentClass: 'notes',
  educationalIntent: true,
  injectionSuspicion: 0.01,
  piiDensity: 0.01,
  copyrightSuspicion: 0.01,
  topics: ['topic-a'],
  teachableDensity: 0.8,
  sizeBand: { minLessons: 3, maxLessons: 6, mode: 'source_only' as const },
  suggestedGoal: 'Learn the material in the uploaded notes',
  questions: [],
  warnings: [],
  perDocument: [],
});

const seedDoc = async (params: {
  userId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  filename?: string;
  mimeType?: string;
  kind?: 'file' | 'url';
  sourceUrl?: string;
  status?: string;
  pageCount?: number;
  extractedTokens?: number;
}) => {
  const id = new mongoose.Types.ObjectId();
  return SourceDocumentModel.create({
    _id: id,
    userId: params.userId,
    courseId: params.courseId,
    kind: params.kind ?? 'file',
    ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
    filename: params.filename ?? `${id.toString()}.pdf`,
    mimeType: params.mimeType ?? 'application/pdf',
    byteSize: 10,
    sha256: id.toString().padEnd(64, '0'),
    s3Key: `uploads/${params.userId.toString()}/${params.courseId.toString()}/${id.toString()}`,
    status: params.status ?? 'uploaded',
    ...(params.pageCount !== undefined ? { pageCount: params.pageCount } : {}),
    ...(params.extractedTokens !== undefined ? { extractedTokens: params.extractedTokens } : {}),
  });
};

const setup = async () => {
  const user = await makeUser();
  const course = await makeCourse({ userId: user._id, status: 'creating', goal: 'Course from documents' });
  await CourseModel.updateOne({ _id: course._id }, { $set: { source: 'documents' } });
  const events: LessonProgressEvent[] = [];
  const emitProgress = (event: LessonProgressEvent) => events.push(event);
  return { user, course, events, emitProgress };
};

const run = (params: { courseId: mongoose.Types.ObjectId; userId: mongoose.Types.ObjectId; emitProgress: (e: LessonProgressEvent) => void }) =>
  runIngestDocuments({
    courseId: params.courseId.toString(),
    userId: params.userId.toString(),
    emitProgress: params.emitProgress,
  });

beforeEach(() => {
  vi.clearAllMocks();
  extractDocumentMock.mockResolvedValue(extraction('# Notes\n\nSome useful content.', { pageCount: 2 }));
  moderateTextMock.mockResolvedValue(passOutcome());
  moderateImagesMock.mockResolvedValue({ decision: 'pass', categories: [], maxScores: {}, warnings: [] });
  screenBeforeVisionMock.mockImplementation(async (_images, _ctx, vision) => ({
    verdict: { decision: 'pass', categories: [], maxScores: {}, warnings: [] },
    visionResult: await vision(_images),
  }));
  enumerateEmbeddedImagesMock.mockReturnValue({ images: [], warnings: [] });
  hashScreenImagesMock.mockResolvedValue({ screened: false });
  assessDocumentsMock.mockImplementation(async (input) => ({
    ...baseVerdict(),
    perDocument: input.perDocSummaries.map((d: { documentId: string; filename: string; status?: string; rejectionReason?: string | null; warnings?: string[] }) => ({
      documentId: d.documentId,
      filename: d.filename,
      status: d.status ?? 'parsed',
      rejectionReason: d.rejectionReason ?? null,
      warnings: d.warnings ?? [],
    })),
  }));
  buildSourceDigestMock.mockResolvedValue({ topics: [{ topic: 'topic-a', spanRefs: [], docIds: [] }] });
  indexSourceDocumentMock.mockResolvedValue({ ok: true, chunksWritten: 2 });
  getObjectBufferMock.mockResolvedValue(Buffer.from('raw-bytes'));
  uploadBufferMock.mockImplementation(async ({ key }: { key: string }) => key);
});

// ── Happy path ──────────────────────────────────────────

describe('runIngestDocuments — happy path', () => {
  test('two docs: parsed with stats, chunks indexed, assessment + digest persisted, goal untouched, events in order', async () => {
    const { user, course, events, emitProgress } = await setup();
    const docA = await seedDoc({ userId: user._id, courseId: course._id, filename: 'a.pdf' });
    const docB = await seedDoc({ userId: user._id, courseId: course._id, filename: 'b.docx', mimeType: DOCX_MIME });

    await run({ courseId: course._id, userId: user._id, emitProgress });

    const a = await SourceDocumentModel.findById(docA._id).lean();
    const b = await SourceDocumentModel.findById(docB._id).lean();
    expect(a?.status).toBe('parsed');
    expect(b?.status).toBe('parsed');
    expect(a?.pageCount).toBe(2);
    expect(a?.extractedTokens).toBeGreaterThan(0);
    expect(a?.parsedS3Key).toMatch(new RegExp(`^uploads/${user._id.toString()}/${course._id.toString()}/parsed/[0-9a-f]{64}$`));

    // Parsed markdown persisted inside the course prefix.
    expect(uploadBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringContaining(`uploads/${user._id.toString()}/${course._id.toString()}/parsed/`) }),
    );

    expect(indexSourceDocumentMock).toHaveBeenCalledTimes(2);

    const courseAfter = await CourseModel.findById(course._id).lean();
    expect(courseAfter?.sourceAssessment).toMatchObject({ topics: ['topic-a'], suggestedGoal: baseVerdict().suggestedGoal });
    // Server-only risk scores never reach the persisted assessment (A10).
    expect(courseAfter?.sourceAssessment).not.toHaveProperty('injectionSuspicion');
    expect(courseAfter?.sourceDigest).toMatchObject({ topics: [{ topic: 'topic-a' }] });
    // suggestedGoal is NOT auto-applied — the user confirms via PATCH (Phase 6).
    expect(courseAfter?.goal).toBe('Course from documents');

    // Per-doc event subsequence: parsing → parsed.
    for (const docId of [docA._id.toString(), docB._id.toString()]) {
      const docEvents = events.filter((e) => e.type === 'document_status' && e.documentId === docId);
      expect(docEvents.map((e) => (e.type === 'document_status' ? e.status : ''))).toEqual(['parsing', 'parsed']);
    }
  });

  test('a doc left in `parsing` by a crashed run is re-ingested (wipe-then-write makes it safe)', async () => {
    const { user, course, emitProgress } = await setup();
    const doc = await seedDoc({ userId: user._id, courseId: course._id, status: 'parsing' });

    await run({ courseId: course._id, userId: user._id, emitProgress });

    expect((await SourceDocumentModel.findById(doc._id).lean())?.status).toBe('parsed');
    expect(indexSourceDocumentMock).toHaveBeenCalledTimes(1);
  });

  test('url doc: extracted via the url path, snapshot persisted to the reserved s3Key, sha256 updated', async () => {
    const { user, course, emitProgress } = await setup();
    const doc = await seedDoc({
      userId: user._id,
      courseId: course._id,
      kind: 'url',
      sourceUrl: 'https://example.com/article',
      filename: 'https://example.com/article',
      mimeType: 'text/html',
    });
    const priorSha = doc.sha256;

    await run({ courseId: course._id, userId: user._id, emitProgress });

    expect(extractDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'url', sourceUrl: 'https://example.com/article' }),
      expect.objectContaining({ mode: 'triage' }),
    );
    // Snapshot persisted at the doc's reserved key.
    expect(uploadBufferMock).toHaveBeenCalledWith(expect.objectContaining({ key: doc.s3Key }));
    const after = await SourceDocumentModel.findById(doc._id).lean();
    expect(after?.status).toBe('parsed');
    expect(after?.sha256).not.toBe(priorSha);
    expect(after?.byteSize).toBeGreaterThan(0);
  });
});

// ── URL rights-reservation gate (Phase 1 / plan A9) ──────

describe('runIngestDocuments — url rights reservation', () => {
  const seedUrlDoc = (user: { _id: mongoose.Types.ObjectId }, course: { _id: mongoose.Types.ObjectId }, url: string) =>
    seedDoc({
      userId: user._id,
      courseId: course._id,
      kind: 'url',
      sourceUrl: url,
      filename: url,
      mimeType: 'text/html',
    });

  test('an allowed URL persists the reservation audit trail alongside the snapshot', async () => {
    const { user, course, emitProgress } = await setup();
    const checkedAt = new Date('2026-07-30T12:00:00Z');
    const doc = await seedUrlDoc(user, course, 'https://example.com/open');
    extractDocumentMock.mockResolvedValue(
      extraction('# Open article\n\nText.', { pageCount: 1, reservation: { signal: 'no_reservation', checkedAt } }),
    );

    await run({ courseId: course._id, userId: user._id, emitProgress });

    const after = await SourceDocumentModel.findById(doc._id).lean();
    expect(after?.status).toBe('parsed');
    expect(after?.reservationSignal).toBe('no_reservation');
    expect(after?.reservationCheckedAt?.toISOString()).toBe(checkedAt.toISOString());
  });

  test('a blocked URL is a per-document REJECTION with the audit trail, while sibling documents still parse', async () => {
    const { user, course, events, emitProgress } = await setup();
    const checkedAt = new Date('2026-07-30T12:00:00Z');
    const blocked = await seedUrlDoc(user, course, 'https://reserved.test/article');
    const sibling = await seedDoc({ userId: user._id, courseId: course._id, filename: 'notes.pdf' });

    extractDocumentMock.mockImplementation(async (input: { kind: string }) => {
      if (input.kind === 'url') {
        throw new ExtractionError(URL_BLOCKED_BY_RESERVATION, 'the source reserves automated use', {
          signal: 'robots_disallow',
          checkedAt,
        });
      }
      return extraction('# Notes\n\nUseful.', { pageCount: 2 });
    });

    await run({ courseId: course._id, userId: user._id, emitProgress });

    const blockedAfter = await SourceDocumentModel.findById(blocked._id).lean();
    expect(blockedAfter?.status).toBe('rejected');
    expect(blockedAfter?.rejectionReason).toBe(URL_BLOCKED_BY_RESERVATION);
    expect(blockedAfter?.reservationSignal).toBe('robots_disallow');
    expect(blockedAfter?.reservationCheckedAt?.toISOString()).toBe(checkedAt.toISOString());
    // Honest, category-level warning — never the fetched page.
    expect(blockedAfter?.warnings.join(' ')).toMatch(/automated/i);

    // The corpus continues: the sibling parsed and the run completed.
    expect((await SourceDocumentModel.findById(sibling._id).lean())?.status).toBe('parsed');
    const courseAfter = await CourseModel.findById(course._id).lean();
    expect(courseAfter?.sourceAssessment).toBeTruthy();

    const blockedEvents = events.filter((e) => e.type === 'document_status' && e.documentId === blocked._id.toString());
    expect(blockedEvents.map((e) => (e.type === 'document_status' ? e.status : ''))).toEqual(['parsing', 'rejected']);
  });

  test('a corpus of only reserved URLs fails honestly with CONTENT_REJECTED', async () => {
    const { user, course, emitProgress } = await setup();
    await seedUrlDoc(user, course, 'https://reserved.test/a');
    extractDocumentMock.mockRejectedValue(
      new ExtractionError(URL_BLOCKED_BY_RESERVATION, 'the source reserves automated use', {
        signal: 'tdm_reservation',
        checkedAt: new Date(),
      }),
    );

    await expect(run({ courseId: course._id, userId: user._id, emitProgress })).rejects.toMatchObject({
      errorCode: 'CONTENT_REJECTED',
    });
  });
});

// ── Image pipeline ──────────────────────────────────────

describe('runIngestDocuments — images', () => {
  test('standalone image: hash screen runs BEFORE screenBeforeVision; extraction runs inside the screen wrapper', async () => {
    const { user, course, emitProgress } = await setup();
    await seedDoc({ userId: user._id, courseId: course._id, filename: 'photo.png', mimeType: 'image/png' });

    await run({ courseId: course._id, userId: user._id, emitProgress });

    expect(hashScreenImagesMock).toHaveBeenCalledTimes(1);
    expect(screenBeforeVisionMock).toHaveBeenCalledTimes(1);
    expect(hashScreenImagesMock.mock.invocationCallOrder[0]).toBeLessThan(screenBeforeVisionMock.mock.invocationCallOrder[0]);
    // Vision extraction happened via the wrapper (extractDocument called for the image).
    expect(extractDocumentMock).toHaveBeenCalled();
  });

  test('image moderation reject ⇒ doc rejected terminal with category reason, vision never runs', async () => {
    const { user, course, emitProgress } = await setup();
    const img = await seedDoc({ userId: user._id, courseId: course._id, filename: 'bad.png', mimeType: 'image/png' });
    const ok = await seedDoc({ userId: user._id, courseId: course._id, filename: 'fine.pdf' });

    screenBeforeVisionMock.mockResolvedValueOnce({
      verdict: { decision: 'reject', categories: ['violence'], maxScores: { violence: 0.99 }, warnings: [] },
      visionResult: null,
    });

    await run({ courseId: course._id, userId: user._id, emitProgress });

    const rejected = await SourceDocumentModel.findById(img._id).lean();
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.rejectionReason).toContain('violence');
    expect((await SourceDocumentModel.findById(ok._id).lean())?.status).toBe('parsed');
  });

  test('zip-container doc: embedded images enumerated + moderated; reject ⇒ doc rejected', async () => {
    const { user, course, emitProgress } = await setup();
    const docx = await seedDoc({ userId: user._id, courseId: course._id, filename: 'deck.docx', mimeType: DOCX_MIME });
    const ok = await seedDoc({ userId: user._id, courseId: course._id, filename: 'fine.pdf' });

    enumerateEmbeddedImagesMock.mockReturnValueOnce({
      images: [{ buffer: Buffer.from('img'), mimeType: 'image/png' }],
      warnings: [],
    });
    moderateImagesMock.mockResolvedValueOnce({
      decision: 'reject',
      categories: ['sexual/minors'],
      maxScores: {},
      warnings: [],
    });

    await run({ courseId: course._id, userId: user._id, emitProgress });

    expect((await SourceDocumentModel.findById(docx._id).lean())?.status).toBe('rejected');
    expect((await SourceDocumentModel.findById(ok._id).lean())?.status).toBe('parsed');
  });

  test('hash-screen throw ⇒ doc failed closed, retryable', async () => {
    const { user, course, emitProgress } = await setup();
    const img = await seedDoc({ userId: user._id, courseId: course._id, filename: 'x.png', mimeType: 'image/png' });
    const ok = await seedDoc({ userId: user._id, courseId: course._id, filename: 'fine.pdf' });

    hashScreenImagesMock.mockRejectedValueOnce(new Error('photodna http 500'));

    await run({ courseId: course._id, userId: user._id, emitProgress });

    expect((await SourceDocumentModel.findById(img._id).lean())?.status).toBe('failed');
    expect((await SourceDocumentModel.findById(ok._id).lean())?.status).toBe('parsed');
  });
});

// ── Text moderation outcomes ────────────────────────────

describe('runIngestDocuments — moderation outcomes', () => {
  test('text reject ⇒ rejected terminal with category-level reason; other docs continue', async () => {
    const { user, course, emitProgress } = await setup();
    const bad = await seedDoc({ userId: user._id, courseId: course._id, filename: 'bad.pdf' });
    const good = await seedDoc({ userId: user._id, courseId: course._id, filename: 'good.pdf' });

    extractDocumentMock.mockImplementation(async (input: { filename: string }) =>
      extraction(input.filename === 'bad.pdf' ? 'BAD CONTENT' : 'good content', { pageCount: 1 }),
    );
    moderateTextMock.mockImplementation(async (chunks: string[]) =>
      chunks.some((c) => c.includes('BAD'))
        ? { decision: 'reject', categories: ['violence'], maxScores: {}, warnings: [], adjudication: null }
        : passOutcome(),
    );

    await run({ courseId: course._id, userId: user._id, emitProgress });

    const badAfter = await SourceDocumentModel.findById(bad._id).lean();
    expect(badAfter?.status).toBe('rejected');
    expect(badAfter?.rejectionReason).toContain('violence');
    expect((await SourceDocumentModel.findById(good._id).lean())?.status).toBe('parsed');

    // Assessment still ran, and its perDocument covers BOTH docs.
    const input = assessDocumentsMock.mock.calls[0][0];
    expect(input.perDocSummaries).toHaveLength(2);
  });

  test('inconclusive adjudication ⇒ doc failed (retryable), never terminal rejected', async () => {
    const { user, course, emitProgress } = await setup();
    const doc = await seedDoc({ userId: user._id, courseId: course._id, filename: 'grey.pdf' });
    await seedDoc({ userId: user._id, courseId: course._id, filename: 'fine.pdf' });

    extractDocumentMock.mockImplementation(async (input: { filename: string }) =>
      extraction(input.filename === 'grey.pdf' ? 'GREY CONTENT' : 'fine content', { pageCount: 1 }),
    );
    moderateTextMock.mockImplementation(async (chunks: string[]) =>
      chunks.some((c) => c.includes('GREY'))
        ? {
            decision: 'reject',
            categories: ['violence'],
            maxScores: {},
            warnings: [],
            adjudication: { verdict: 'reject', reason: MODERATION_INCONCLUSIVE_REASON },
          }
        : passOutcome(),
    );

    await run({ courseId: course._id, userId: user._id, emitProgress });

    const after = await SourceDocumentModel.findById(doc._id).lean();
    expect(after?.status).toBe('failed');
    expect(after?.rejectionReason).toBeNull();
  });

  test('moderation provider outage ⇒ doc failed retryable, NEVER pass-through; empty corpus fails CONTENT_REJECTED with meta', async () => {
    const { user, course, emitProgress } = await setup();
    const doc = await seedDoc({ userId: user._id, courseId: course._id });

    moderateTextMock.mockRejectedValue(new ModerationUnavailableError('outage'));

    let thrown: unknown;
    try {
      await run({ courseId: course._id, userId: user._id, emitProgress });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).errorCode).toBe('CONTENT_REJECTED');
    expect((thrown as AppError).meta).toMatchObject({ rejected: 0, failed: 1 });

    expect((await SourceDocumentModel.findById(doc._id).lean())?.status).toBe('failed');
    expect(indexSourceDocumentMock).not.toHaveBeenCalled();
  });

  test('all docs rejected ⇒ job fails CONTENT_REJECTED with {rejected, failed} meta', async () => {
    const { user, course, emitProgress } = await setup();
    await seedDoc({ userId: user._id, courseId: course._id });

    moderateTextMock.mockResolvedValue({
      decision: 'reject',
      categories: ['violence'],
      maxScores: {},
      warnings: [],
      adjudication: null,
    });

    await expect(run({ courseId: course._id, userId: user._id, emitProgress })).rejects.toMatchObject({
      errorCode: 'CONTENT_REJECTED',
      meta: { rejected: 1, failed: 0 },
    });

    const courseAfter = await CourseModel.findById(course._id).lean();
    expect(courseAfter?.sourceAssessment).toBeNull();
  });
});

// ── A9 corpus caps ──────────────────────────────────────

describe('runIngestDocuments — corpus caps', () => {
  test(`a ${MAX_CORPUS_PAGES + 1}-page doc fails with a limit warning; the job continues for other docs`, async () => {
    const { user, course, emitProgress } = await setup();
    const big = await seedDoc({ userId: user._id, courseId: course._id, filename: 'big.pdf' });
    const small = await seedDoc({ userId: user._id, courseId: course._id, filename: 'small.pdf' });

    extractDocumentMock.mockImplementation(async (input: { filename: string }) =>
      input.filename === 'big.pdf'
        ? extraction('big doc', { pageCount: MAX_CORPUS_PAGES + 1 })
        : extraction('small doc', { pageCount: 1 }),
    );

    await run({ courseId: course._id, userId: user._id, emitProgress });

    const bigAfter = await SourceDocumentModel.findById(big._id).lean();
    expect(bigAfter?.status).toBe('failed');
    expect(bigAfter?.warnings.join(' ')).toMatch(/limit/i);
    expect((await SourceDocumentModel.findById(small._id).lean())?.status).toBe('parsed');
  });

  test('token cap already exhausted by previously-parsed docs ⇒ further docs are not ingested; assessment carries a warning', async () => {
    const { user, course, emitProgress } = await setup();
    // A previously-parsed doc already consumed the whole token budget.
    await seedDoc({
      userId: user._id,
      courseId: course._id,
      filename: 'previous.pdf',
      status: 'parsed',
      pageCount: 10,
      extractedTokens: MAX_CORPUS_TOKENS,
    });
    const skipped = await seedDoc({ userId: user._id, courseId: course._id, filename: 'skipped.pdf' });

    await run({ courseId: course._id, userId: user._id, emitProgress });

    const skippedAfter = await SourceDocumentModel.findById(skipped._id).lean();
    expect(skippedAfter?.status).toBe('uploaded'); // untouched — not ingested
    expect(extractDocumentMock).not.toHaveBeenCalled();

    const courseAfter = await CourseModel.findById(course._id).lean();
    const warnings = (courseAfter?.sourceAssessment as { warnings: string[] }).warnings.join(' ');
    expect(warnings).toMatch(/limit/i);
  });
});

// ── deriveEscalatedPages (BUG-2 unit pins) ──────────────────
//
// The resume marker must count a scanned page that WAS sent to vision even
// when it produced no block (blank / unreadable scan) — otherwise the doc
// looks permanently unprepared and re-fires paid prepare_corpus runs. It
// must NOT count a page vision never touched.

describe('deriveEscalatedPages', () => {
  test('counts pages actually sent to vision even when they yielded no block', () => {
    expect(
      deriveEscalatedPages({
        markdown: 'page 1 only',
        blocks: [{ type: 'text', markdown: 'page 1 only', headingPath: [], pageRange: { start: 1, end: 1 } }],
        scannedPages: [1, 2, 3, 4, 5],
        visionAttemptedPages: [1, 2, 3, 4, 5],
        warnings: [],
      }),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test('counts only the attempted subset when vision stopped early', () => {
    expect(
      deriveEscalatedPages({
        markdown: '',
        blocks: [],
        scannedPages: [1, 2, 3, 4, 5],
        visionAttemptedPages: [1, 2],
        warnings: [],
      }),
    ).toEqual([1, 2]);
  });

  test('ignores attempted pages that are not scanned pages (never marks work that was not needed)', () => {
    expect(
      deriveEscalatedPages({
        markdown: '',
        blocks: [],
        scannedPages: [3],
        visionAttemptedPages: [1, 2, 3],
        warnings: [],
      }),
    ).toEqual([3]);
  });

  test('still derives from block page ranges when the extractor reports no attempted list', () => {
    expect(
      deriveEscalatedPages({
        markdown: 'x',
        blocks: [{ type: 'text', markdown: 'x', headingPath: [], pageRange: { start: 2, end: 3 } }],
        scannedPages: [2, 3, 4],
        warnings: [],
      }),
    ).toEqual([2, 3]);
  });

  test('no scanned pages ⇒ no markers', () => {
    expect(deriveEscalatedPages({ markdown: 'x', blocks: [], warnings: [] })).toEqual([]);
  });
});
