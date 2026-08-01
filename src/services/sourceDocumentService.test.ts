/**
 * Tests for sourceDocumentService — the upload-surface service for
 * course-from-documents Phase 1: magic-byte sniffing (binary formats) +
 * UTF-8 text branch, sha256 dedup-within-course (unique partial index),
 * race-safe A9 caps (≤10 files, ≤10 URLs per course), URL validation
 * (scheme + private-host shapes, no fetching), and owner-scoped delete.
 *
 * S3 is mocked — the service must call uploadBuffer with a bare
 * `uploads/{userId}/{courseId}/{docId}` key (never a presigned URL).
 *
 * Run: yarn test sourceDocumentService
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { setupTestDb } from '../../test-helpers/db';
import SourceDocumentModel from '@models/SourceDocumentModel';
import { AppError } from '@middleware/errorMiddleware';

vi.mock('@services/s3Service', () => ({
  uploadBuffer: vi.fn(async ({ key }: { key: string }) => key),
  deleteByPrefix: vi.fn(async () => 1),
}));

import { uploadBuffer, deleteByPrefix } from '@services/s3Service';
import {
  createFileDocument,
  createUrlDocument,
  deleteSourceDocument,
  listCourseDocuments,
  validateSourceUrl,
  MAX_FILES_PER_COURSE,
  MAX_URLS_PER_COURSE,
  toClientSourceDocument,
} from '@services/sourceDocumentService';

setupTestDb();

beforeAll(async () => {
  // The dedup guarantees ride on the unique partial indexes — make sure
  // they exist before any test writes.
  await SourceDocumentModel.syncIndexes();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Fixtures ───────────────────────────────────────────────

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n'), Buffer.alloc(64)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
const EXE = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]), Buffer.alloc(64)]);
const MP3 = Buffer.concat([
  Buffer.from('ID3'),
  Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0xff, 0xfb, 0x90, 0x00]),
  Buffer.alloc(64),
]);
const UTF8_TEXT = Buffer.from('# My study notes\n\nPhotosynthesis converts light to energy.\n');
const BINARY_JUNK = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x83, 0x92, 0xc0, 0x00, 0x9f, 0x11]);
const CONTROL_HEAVY = Buffer.from(
  'ab\u0001\u0002\u0003\u0004\u0005\u0006cd\u000b\u000e\u000f\u0010ef',
);

const ids = () => ({
  userId: new mongoose.Types.ObjectId().toString(),
  courseId: new mongoose.Types.ObjectId().toString(),
});

const uploadFile = (
  args: Partial<Parameters<typeof createFileDocument>[0]> & { userId: string; courseId: string },
) =>
  createFileDocument({
    buffer: PDF,
    filename: 'notes.pdf',
    ...args,
  });

const expectAppError = async (
  p: Promise<unknown>,
  { errorCode, statusCode }: { errorCode: string; statusCode: number },
) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err, 'expected a rejection').toBeInstanceOf(AppError);
  expect((err as AppError).errorCode).toBe(errorCode);
  expect((err as AppError).statusCode).toBe(statusCode);
  return err as AppError;
};

// ── Sniffing / allowlist matrix ────────────────────────────

describe('createFileDocument — sniffing', () => {
  test('text PDF accepted; row uploaded; S3 key bare and user/course scoped', async () => {
    const { userId, courseId } = ids();
    const { document, deduped } = await uploadFile({ userId, courseId });
    expect(deduped).toBe(false);
    expect(document.status).toBe('uploaded');
    expect(document.kind).toBe('file');
    expect(document.mimeType).toBe('application/pdf');
    expect(document.sha256).toBe(crypto.createHash('sha256').update(PDF).digest('hex'));
    expect(document.s3Key).toBe(`uploads/${userId}/${courseId}/${document._id.toString()}`);
    expect(document.s3Key).not.toContain('http');
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
  });

  test('png accepted with normalized mime even under a lying claimed name', async () => {
    const { userId, courseId } = ids();
    const { document } = await uploadFile({
      userId,
      courseId,
      buffer: PNG,
      filename: 'actually-a-scan.pdf',
    });
    // Sniff wins for binary formats: bytes say png, so we store png.
    expect(document.mimeType).toBe('image/png');
  });

  test('mp3 accepted', async () => {
    const { userId, courseId } = ids();
    const { document } = await uploadFile({
      userId,
      courseId,
      buffer: MP3,
      filename: 'lecture.mp3',
    });
    expect(document.mimeType).toBe('audio/mpeg');
  });

  test('exe renamed to .pdf rejected UNSUPPORTED_FILE_TYPE', async () => {
    const { userId, courseId } = ids();
    await expectAppError(
      uploadFile({ userId, courseId, buffer: EXE, filename: 'totally-a.pdf' }),
      { errorCode: 'UNSUPPORTED_FILE_TYPE', statusCode: 400 },
    );
    expect(await SourceDocumentModel.countDocuments({})).toBe(0);
  });

  test('utf-8 .txt accepted via the text branch', async () => {
    const { userId, courseId } = ids();
    const { document } = await uploadFile({
      userId,
      courseId,
      buffer: UTF8_TEXT,
      filename: 'notes.txt',
    });
    expect(document.mimeType).toBe('text/plain');
  });

  test.each([
    ['notes.md', 'text/markdown'],
    ['data.csv', 'text/csv'],
    ['page.html', 'text/html'],
  ])('text branch accepts %s as %s', async (filename, mime) => {
    const { userId, courseId } = ids();
    const { document } = await uploadFile({ userId, courseId, buffer: UTF8_TEXT, filename });
    expect(document.mimeType).toBe(mime);
  });

  test('binary junk with a .txt name rejected (invalid UTF-8)', async () => {
    const { userId, courseId } = ids();
    await expectAppError(
      uploadFile({ userId, courseId, buffer: BINARY_JUNK, filename: 'junk.txt' }),
      { errorCode: 'UNSUPPORTED_FILE_TYPE', statusCode: 400 },
    );
  });

  test('control-character-heavy .txt rejected', async () => {
    const { userId, courseId } = ids();
    await expectAppError(
      uploadFile({ userId, courseId, buffer: CONTROL_HEAVY, filename: 'weird.txt' }),
      { errorCode: 'UNSUPPORTED_FILE_TYPE', statusCode: 400 },
    );
  });

  test('unsniffed bytes behind a non-text extension rejected', async () => {
    const { userId, courseId } = ids();
    await expectAppError(
      uploadFile({ userId, courseId, buffer: UTF8_TEXT, filename: 'notes.docx' }),
      { errorCode: 'UNSUPPORTED_FILE_TYPE', statusCode: 400 },
    );
  });

  test('empty file rejected without persisting anything', async () => {
    const { userId, courseId } = ids();
    await expectAppError(
      uploadFile({ userId, courseId, buffer: Buffer.alloc(0), filename: 'empty.txt' }),
      { errorCode: 'CUSTOM_ERROR', statusCode: 400 },
    );
    expect(uploadBuffer).not.toHaveBeenCalled();
  });
});

// ── Dedup ──────────────────────────────────────────────────

describe('createFileDocument — sha256 dedup within a course', () => {
  test('same bytes twice → same row, second call deduped, one S3 write', async () => {
    const { userId, courseId } = ids();
    const first = await uploadFile({ userId, courseId });
    const second = await uploadFile({ userId, courseId, filename: 'renamed-copy.pdf' });
    expect(second.deduped).toBe(true);
    expect(second.document._id.toString()).toBe(first.document._id.toString());
    expect(await SourceDocumentModel.countDocuments({})).toBe(1);
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
  });

  test('same bytes in a DIFFERENT course are a separate document (no cross-course dedup)', async () => {
    const { userId } = ids();
    const courseA = new mongoose.Types.ObjectId().toString();
    const courseB = new mongoose.Types.ObjectId().toString();
    const a = await uploadFile({ userId, courseId: courseA });
    const b = await uploadFile({ userId, courseId: courseB });
    expect(a.document._id.toString()).not.toBe(b.document._id.toString());
    expect(await SourceDocumentModel.countDocuments({})).toBe(2);
  });

  test('concurrent duplicate uploads settle on one row', async () => {
    const { userId, courseId } = ids();
    const results = await Promise.all([
      uploadFile({ userId, courseId }),
      uploadFile({ userId, courseId }),
    ]);
    expect(results[0].document._id.toString()).toBe(results[1].document._id.toString());
    expect(await SourceDocumentModel.countDocuments({})).toBe(1);
  });
});

// ── Caps ───────────────────────────────────────────────────

const distinctPdf = (i: number) =>
  Buffer.concat([Buffer.from(`%PDF-1.4\n% variant ${i}\n`), Buffer.alloc(32)]);

describe('createFileDocument — A9 caps', () => {
  test('11th file rejected with DOCUMENT_LIMIT_EXCEEDED and {limit, have} meta', async () => {
    const { userId, courseId } = ids();
    for (let i = 0; i < MAX_FILES_PER_COURSE; i++) {
      await uploadFile({ userId, courseId, buffer: distinctPdf(i), filename: `f${i}.pdf` });
    }
    const err = await expectAppError(
      uploadFile({ userId, courseId, buffer: distinctPdf(99), filename: 'one-too-many.pdf' }),
      { errorCode: 'DOCUMENT_LIMIT_EXCEEDED', statusCode: 400 },
    );
    expect(err.meta).toMatchObject({ limit: MAX_FILES_PER_COURSE, have: MAX_FILES_PER_COURSE });
    expect(await SourceDocumentModel.countDocuments({ courseId })).toBe(MAX_FILES_PER_COURSE);
  });

  test('race: concurrent 10th + 11th inserts → exactly one succeeds, cap never exceeded', async () => {
    const { userId, courseId } = ids();
    for (let i = 0; i < MAX_FILES_PER_COURSE - 1; i++) {
      await uploadFile({ userId, courseId, buffer: distinctPdf(i), filename: `f${i}.pdf` });
    }
    const outcomes = await Promise.allSettled([
      uploadFile({ userId, courseId, buffer: distinctPdf(100), filename: 'tenth.pdf' }),
      uploadFile({ userId, courseId, buffer: distinctPdf(101), filename: 'eleventh.pdf' }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason as AppError;
    expect(err.errorCode).toBe('DOCUMENT_LIMIT_EXCEEDED');
    expect(await SourceDocumentModel.countDocuments({ courseId })).toBe(MAX_FILES_PER_COURSE);
  });

  test('url cap is independent of the file cap', async () => {
    const { userId, courseId } = ids();
    for (let i = 0; i < MAX_FILES_PER_COURSE; i++) {
      await uploadFile({ userId, courseId, buffer: distinctPdf(i), filename: `f${i}.pdf` });
    }
    // Files are full — URLs must still be accepted.
    const { document } = await createUrlDocument({
      userId,
      courseId,
      url: 'https://example.com/article',
    });
    expect(document.kind).toBe('url');
  });
});

// ── A9 audio cap (≤180 min / course, probed at upload) ─────

/**
 * Minimal valid RIFF/WAVE container whose header probe yields
 * `dataLength / byteRate` seconds. byteRate=1 keeps multi-hour fixtures
 * tiny (1 byte of PCM per second); `seed` varies the data so sha256
 * dedup doesn't collapse distinct fixtures.
 */
const wavFixture = ({ seconds, seed = 0 }: { seconds: number; seed?: number }): Buffer => {
  const byteRate = 1;
  const dataLength = seconds * byteRate;
  const buf = Buffer.alloc(44 + dataLength, seed & 0xff);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(8000, 24); // sample rate (unused by the probe)
  buf.writeUInt32LE(byteRate, 28); // byteRate — the probe's divisor
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLength, 40);
  return buf;
};

describe('createFileDocument — A9 audio cap (≤180 min/course)', () => {
  test('a single wav over 180 minutes is rejected with DOCUMENT_LIMIT_EXCEEDED at upload', async () => {
    const { userId, courseId } = ids();
    const err = await expectAppError(
      uploadFile({
        userId,
        courseId,
        buffer: wavFixture({ seconds: 181 * 60 }),
        filename: 'marathon-lecture.wav',
      }),
      { errorCode: 'DOCUMENT_LIMIT_EXCEEDED', statusCode: 400 },
    );
    expect(err.meta).toMatchObject({ limit: 180, unit: 'audio minutes' });
    expect(await SourceDocumentModel.countDocuments({ courseId })).toBe(0);
  });

  test('the budget accumulates across audio files on the course', async () => {
    const { userId, courseId } = ids();
    const { document } = await uploadFile({
      userId,
      courseId,
      buffer: wavFixture({ seconds: 100 * 60, seed: 1 }),
      filename: 'part-1.wav',
    });
    // The probed duration is persisted so later uploads can budget on it.
    expect(document.audioDurationSec).toBe(100 * 60);

    const err = await expectAppError(
      uploadFile({
        userId,
        courseId,
        buffer: wavFixture({ seconds: 100 * 60, seed: 2 }),
        filename: 'part-2.wav',
      }),
      { errorCode: 'DOCUMENT_LIMIT_EXCEEDED', statusCode: 400 },
    );
    expect(err.meta).toMatchObject({ limit: 180, have: 100, unit: 'audio minutes' });
  });

  test('audio under the cap is accepted and does not block non-audio uploads', async () => {
    const { userId, courseId } = ids();
    const { document } = await uploadFile({
      userId,
      courseId,
      buffer: wavFixture({ seconds: 170 * 60, seed: 3 }),
      filename: 'long-but-ok.wav',
    });
    expect(document.status).toBe('uploaded');
    // A PDF after the audio budget is nearly spent is unaffected.
    const pdf = await uploadFile({ userId, courseId, buffer: distinctPdf(7), filename: 'notes.pdf' });
    expect(pdf.document.status).toBe('uploaded');
  });

  test('unprobeable audio (m4a without a moov box) is admitted with a warning, not rejected', async () => {
    const { userId, courseId } = ids();
    // Sniffs as m4a (ftyp/M4A brand) but carries no moov→mvhd, so the
    // duration probe returns unknown ⇒ fail-open with a warning (recorded
    // review decision; per-file byte caps still bound the cost).
    const M4A_NO_MOOV = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypM4A ', 'ascii'),
      Buffer.from('\x00\x00\x00\x00M4A mp42', 'ascii'),
      Buffer.alloc(32),
    ]);
    const { document } = await uploadFile({ userId, courseId, buffer: M4A_NO_MOOV, filename: 'clip.m4a' });
    expect(document.status).toBe('uploaded');
    expect(document.warnings).toContain('audio duration could not be determined at upload');
  });
});

// ── URL documents ──────────────────────────────────────────

describe('validateSourceUrl', () => {
  test.each([
    'https://example.com/article',
    'http://example.com/article?page=2',
    'https://sub.domain.example.co.uk/deep/path',
  ])('accepts %s', (url) => {
    expect(validateSourceUrl(url).ok).toBe(true);
  });

  test.each([
    'ftp://example.com/file',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://localhost/admin',
    'http://localhost:4000/admin',
    'https://127.0.0.1/secrets',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal',
    'http://192.168.1.1/router',
    'http://172.16.0.1/private',
    'http://[::1]/',
    'http://[fd00::1]/',
    'https://foo.internal/wiki',
    'https://printer.local/jobs',
    'https://intranet/portal',
    'http://0x7f000001/',
    'https://user:pass@example.com/paywalled',
    'not a url at all',
  ])('rejects %s', (url) => {
    expect(validateSourceUrl(url).ok).toBe(false);
  });

  test('strips fragments during normalization', () => {
    const result = validateSourceUrl('https://example.com/article#section-2');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe('https://example.com/article');
  });
});

describe('createUrlDocument', () => {
  test('creates an uploaded url-kind row without fetching anything', async () => {
    const { userId, courseId } = ids();
    const { document, deduped } = await createUrlDocument({
      userId,
      courseId,
      url: 'https://example.com/article',
    });
    expect(deduped).toBe(false);
    expect(document.kind).toBe('url');
    expect(document.sourceUrl).toBe('https://example.com/article');
    expect(document.status).toBe('uploaded');
    // No fetch in Phase 1 → no S3 snapshot write.
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  test('rejects a private-host URL with a 400', async () => {
    const { userId, courseId } = ids();
    await expectAppError(
      createUrlDocument({ userId, courseId, url: 'http://169.254.169.254/latest/meta-data/' }),
      { errorCode: 'CUSTOM_ERROR', statusCode: 400 },
    );
  });

  test('same URL twice → deduped to one row', async () => {
    const { userId, courseId } = ids();
    const first = await createUrlDocument({ userId, courseId, url: 'https://example.com/a' });
    const second = await createUrlDocument({ userId, courseId, url: 'https://example.com/a' });
    expect(second.deduped).toBe(true);
    expect(second.document._id.toString()).toBe(first.document._id.toString());
    expect(await SourceDocumentModel.countDocuments({})).toBe(1);
  });

  test('11th URL rejected with DOCUMENT_LIMIT_EXCEEDED', async () => {
    const { userId, courseId } = ids();
    for (let i = 0; i < MAX_URLS_PER_COURSE; i++) {
      await createUrlDocument({ userId, courseId, url: `https://example.com/article-${i}` });
    }
    const err = await expectAppError(
      createUrlDocument({ userId, courseId, url: 'https://example.com/one-too-many' }),
      { errorCode: 'DOCUMENT_LIMIT_EXCEEDED', statusCode: 400 },
    );
    expect(err.meta).toMatchObject({ limit: MAX_URLS_PER_COURSE, have: MAX_URLS_PER_COURSE });
  });
});

// ── List / delete / client shape ───────────────────────────

describe('listCourseDocuments / deleteSourceDocument / toClientSourceDocument', () => {
  test('list returns only the course rows, oldest first', async () => {
    const { userId, courseId } = ids();
    const other = new mongoose.Types.ObjectId().toString();
    await uploadFile({ userId, courseId, buffer: distinctPdf(1), filename: 'a.pdf' });
    await uploadFile({ userId, courseId, buffer: distinctPdf(2), filename: 'b.pdf' });
    await uploadFile({ userId, courseId: other, buffer: distinctPdf(3), filename: 'other.pdf' });
    const docs = await listCourseDocuments({ courseId });
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.filename)).toEqual(['a.pdf', 'b.pdf']);
  });

  test('client shape exposes no s3Key/sha256/userId', async () => {
    const { userId, courseId } = ids();
    const { document } = await uploadFile({ userId, courseId });
    const client = toClientSourceDocument(document) as Record<string, unknown>;
    expect(client.id).toBe(document._id.toString());
    expect(client.filename).toBe('notes.pdf');
    expect(client.status).toBe('uploaded');
    expect(client).not.toHaveProperty('s3Key');
    expect(client).not.toHaveProperty('sha256');
    expect(client).not.toHaveProperty('userId');
    expect(client).not.toHaveProperty('courseId');
    expect(client).not.toHaveProperty('parsedS3Key');
  });

  test('delete removes the row and wipes the S3 object', async () => {
    const { userId, courseId } = ids();
    const { document } = await uploadFile({ userId, courseId });
    const deleted = await deleteSourceDocument({
      courseId,
      documentId: document._id.toString(),
    });
    expect(deleted).toBe(true);
    expect(await SourceDocumentModel.countDocuments({})).toBe(0);
    expect(deleteByPrefix).toHaveBeenCalledWith(document.s3Key);
  });

  test('delete scoped to the course — a different courseId cannot delete the row', async () => {
    const { userId, courseId } = ids();
    const { document } = await uploadFile({ userId, courseId });
    const deleted = await deleteSourceDocument({
      courseId: new mongoose.Types.ObjectId().toString(),
      documentId: document._id.toString(),
    });
    expect(deleted).toBe(false);
    expect(await SourceDocumentModel.countDocuments({})).toBe(1);
  });

  test('deleting a slot frees cap room for a new upload', async () => {
    const { userId, courseId } = ids();
    for (let i = 0; i < MAX_FILES_PER_COURSE; i++) {
      await uploadFile({ userId, courseId, buffer: distinctPdf(i), filename: `f${i}.pdf` });
    }
    const docs = await listCourseDocuments({ courseId });
    await deleteSourceDocument({ courseId, documentId: docs[0]._id.toString() });
    const { document } = await uploadFile({
      userId,
      courseId,
      buffer: distinctPdf(500),
      filename: 'replacement.pdf',
    });
    expect(document.status).toBe('uploaded');
  });
});
