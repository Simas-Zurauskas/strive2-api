import crypto from 'node:crypto';
import path from 'node:path';
import mongoose, { Types } from 'mongoose';
import { fromBuffer as sniffMagicBytes } from 'file-type';
import SourceDocumentModel, { SourceDocumentDocument } from '@models/SourceDocumentModel';
import { probeAudioDuration } from '@services/documentExtraction/audio';
import { uploadBuffer, deleteByPrefix } from '@services/s3Service';
import { deleteSourceChunksForDocument } from '@services/sourceDocRagService';
import { AppError } from '@middleware/errorMiddleware';
import { genLog } from '@lib/loggers';

/**
 * Upload surface for course-from-documents (Phase 1): validate + persist
 * raw source documents, no extraction/ingestion here.
 *
 * Trust model: documents are hostile input (plan A8). The multer filter
 * only checks the client's *claim*; this service is the authoritative
 * gate — magic-byte sniff for binary formats, and a strict UTF-8 branch
 * for the text formats that have no magic bytes.
 *
 * Storage: raw bytes land in S3 under `uploads/{userId}/{courseId}/{docId}`
 * (bare key on the row, presigned only at read time — never stored). The
 * user-scoped prefix means account/course deletion is a prefix wipe.
 *
 * Concurrency: all cap-checked writes for a course run under an
 * in-process per-course lock. The service is single-instance by design
 * (CLAUDE.md), so the lock makes the count-then-insert cap check
 * race-safe; a post-insert recount + rollback backstops any out-of-band
 * writer, and the unique partial indexes make duplicate uploads
 * idempotent even without the lock.
 */

// ── A9 caps (tunable constants) ────────────────────────────

export const MAX_FILES_PER_COURSE = 10;
export const MAX_URLS_PER_COURSE = 10;
// ≤180 min of audio per course, enforced at upload (plan §5 audio row:
// ">180 min cap → DOCUMENT_LIMIT_EXCEEDED at upload"). Duration comes
// from the header probe (`probeAudioDuration`); a file whose duration
// cannot be probed is admitted with a warning (fail-open — the same
// approximate-abuse-bound posture as the other A9 caps; per-file limits
// still bound it: 50 MB upload, 25 MB transcription).
export const MAX_AUDIO_SECONDS_PER_COURSE = 180 * 60;

/** `file-type` ext labels that take the audio branch of the upload cap. */
const AUDIO_SNIFF_EXTS = new Set(['mp3', 'm4a', 'wav']);

// ── Per-course write lock ──────────────────────────────────

const courseLocks = new Map<string, Promise<unknown>>();

const withCourseLock = async <T>(courseId: string, fn: () => Promise<T>): Promise<T> => {
  const previous = courseLocks.get(courseId) ?? Promise.resolve();
  // Chain onto the tail regardless of the predecessor's outcome.
  const run = previous.then(fn, fn);
  // Track a settled-safe tail so a rejection here never poisons the chain.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  courseLocks.set(courseId, tail);
  void tail.then(() => {
    if (courseLocks.get(courseId) === tail) courseLocks.delete(courseId);
  });
  return run;
};

// ── Type sniffing ──────────────────────────────────────────

/**
 * Sniffed extensions we accept, mapped from `file-type`'s `ext` labels to
 * the launch-set format they satisfy. Anything else (exe, zip, legacy
 * doc/cfb, video…) is rejected regardless of the claimed name.
 */
const BINARY_SNIFF_ALLOWLIST = new Set<string>([
  'pdf',
  'docx', 'pptx', 'xlsx',
  'odt', 'odp', 'ods',
  'epub',
  'png', 'jpg', 'webp', 'heic', 'heif',
  'mp3', 'm4a', 'wav',
]);

/** Text formats with no magic bytes — the UTF-8 validation branch. */
const TEXT_EXTENSION_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
};

/**
 * Max share of C0/C1 control characters (excluding \t \n \r) a text file
 * may contain. Real prose sits at ~0; a couple of stray ESC sequences in
 * an exported log stay under this; binary masquerading as text blows past
 * it immediately.
 */
const MAX_CONTROL_CHAR_RATIO = 0.02;

const utf8TextCheck = (buffer: Buffer): boolean => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return false;
  }
  if (text.length === 0) return false;
  let control = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const isAllowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if (!isAllowedWhitespace && (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f))) {
      control += 1;
    }
  }
  return control / text.length <= MAX_CONTROL_CHAR_RATIO;
};

export type SniffResult =
  | { ok: true; mimeType: string; detectedExt: string }
  | { ok: false; reason: string };

/**
 * Authoritative type gate. Binary formats: the magic-byte sniff wins —
 * the claimed filename/MIME is ignored (an exe renamed `.pdf` is an exe).
 * Text formats (`txt/md/csv/html`) have no magic bytes and `file-type`
 * returns undefined for them; that branch accepts only when the sniff
 * yields nothing AND the claimed extension is in the text subset AND the
 * bytes are valid UTF-8 with a bounded control-character ratio.
 */
export const sniffDocumentType = async ({
  buffer,
  filename,
}: {
  buffer: Buffer;
  filename: string;
}): Promise<SniffResult> => {
  const sniffed = await sniffMagicBytes(buffer);
  if (sniffed) {
    if (BINARY_SNIFF_ALLOWLIST.has(sniffed.ext)) {
      return { ok: true, mimeType: sniffed.mime, detectedExt: sniffed.ext };
    }
    return { ok: false, reason: `detected ${sniffed.ext} (${sniffed.mime})` };
  }
  const ext = path.extname(filename).toLowerCase();
  const textMime = TEXT_EXTENSION_MIME[ext];
  if (!textMime) {
    return { ok: false, reason: `unrecognized bytes with extension ${ext || 'none'}` };
  }
  if (!utf8TextCheck(buffer)) {
    return { ok: false, reason: 'not valid UTF-8 text' };
  }
  return { ok: true, mimeType: textMime, detectedExt: ext.slice(1) };
};

// ── URL validation (no fetching — validation only) ─────────

/**
 * Host-shape blocklist for URL documents. The fetch itself happens later
 * via Jina Reader (an external egress path), so this is defense in depth
 * against private/metadata targets and obvious junk — NOT a resolved-IP
 * SSRF check (no DNS resolution here by design; we never fetch).
 */
const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  // [base, maskBits]
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local + cloud metadata
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved + broadcast
];

const isPrivateIpv4 = (host: string): boolean => {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return PRIVATE_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (base >>> 0 & mask);
  });
};

const isIpv4Literal = (host: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(host);

export type UrlValidation = { ok: true; url: string } | { ok: false; reason: string };

export const validateSourceUrl = (raw: string): UrlValidation => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return { ok: false, reason: 'URL must be a non-empty string of at most 2048 characters.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'Not a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only http(s) URLs are supported.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not supported.' };
  }
  const host = parsed.hostname.toLowerCase();
  // IPv6 literals (WHATWG keeps the brackets). Rejected wholesale — v6
  // literals can smuggle v4-mapped private addresses and no real article
  // lives at a bare IPv6 address.
  if (host.startsWith('[')) {
    return { ok: false, reason: 'IP-address URLs are not supported — use a public hostname.' };
  }
  // WHATWG URL canonicalizes every IPv4 shorthand (hex/octal/decimal,
  // e.g. http://0x7f000001) to dotted-decimal, so this single check
  // covers the encoded forms too.
  if (isIpv4Literal(host)) {
    if (isPrivateIpv4(host)) {
      return { ok: false, reason: 'Private or reserved addresses are not supported.' };
    }
    return { ok: false, reason: 'IP-address URLs are not supported — use a public hostname.' };
  }
  if (host === 'localhost' || BLOCKED_HOSTNAME_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'Local or internal hostnames are not supported.' };
  }
  // Single-label hosts (no dot) are intranet shapes: http://wiki, http://router.
  if (!host.includes('.')) {
    return { ok: false, reason: 'Use a fully qualified public hostname.' };
  }
  // Normalize: drop the fragment (never sent on the wire anyway); keep
  // query strings — they routinely address the actual article.
  parsed.hash = '';
  let normalized = parsed.toString();
  if (normalized.endsWith('#')) normalized = normalized.slice(0, -1);
  return { ok: true, url: normalized };
};

// ── Client shape ───────────────────────────────────────────

/**
 * The client-facing projection — mirrors the `SourceDocument` OpenAPI
 * schema. Never expose s3Key/sha256/parsedS3Key or the owner ids.
 */
export const toClientSourceDocument = (doc: SourceDocumentDocument) => ({
  id: doc._id.toString(),
  kind: doc.kind,
  sourceUrl: doc.sourceUrl,
  filename: doc.filename,
  mimeType: doc.mimeType,
  byteSize: doc.byteSize,
  status: doc.status,
  rejectionReason: doc.rejectionReason,
  pageCount: doc.pageCount,
  // Deferred-extraction resume markers (Phase 5, additive): the client
  // computes the "needs preparation" predicate from these —
  //   scannedPageCount > escalatedPages.length  (unescalated scans), or
  //   transcribedSec < audioDurationSec         (untranscribed audio tail)
  // — and submits POST /:courseId/prepare-corpus before generate-structure.
  // `escalatedPages` counts every scanned page vision was ASKED to
  // transcribe, blank results included (see `deriveEscalatedPages`), so a
  // completed prepare pass cannot leave the predicate permanently true and
  // re-fire a paid no-op run on every later structure attempt.
  scannedPageCount: doc.scannedPageCount,
  escalatedPages: doc.escalatedPages ?? [],
  audioDurationSec: doc.audioDurationSec,
  transcribedSec: doc.transcribedSec,
  // Rights-reservation audit trail (url documents only) — the record of
  // which machine-readable signal we honoured before fetching, and when.
  // Surfaced because a refused URL is otherwise indistinguishable from any
  // other rejection, and the learner is entitled to the honest reason.
  reservationSignal: doc.reservationSignal ?? null,
  reservationCheckedAt: doc.reservationCheckedAt ?? null,
  warnings: doc.warnings,
  createdAt: doc.createdAt,
});

export type ClientSourceDocument = ReturnType<typeof toClientSourceDocument>;

// ── Create (file) ──────────────────────────────────────────

const documentS3Key = ({
  userId,
  courseId,
  documentId,
}: {
  userId: string;
  courseId: string;
  documentId: Types.ObjectId;
}) => `uploads/${userId}/${courseId}/${documentId.toString()}`;

const capError = (limit: number, have: number, what: string) =>
  new AppError(
    `This course already has the maximum of ${limit} ${what}. Remove one to add another.`,
    { errorCode: 'DOCUMENT_LIMIT_EXCEEDED', statusCode: 400, meta: { limit, have } },
  );

const deleteS3ObjectQuietly = async (key: string) => {
  try {
    await deleteByPrefix(key);
  } catch (e) {
    // Orphaned raw upload — swept by the course-deletion prefix wipe.
    genLog.warn(`sourceDocument: failed to delete S3 object ${key}: ${(e as Error).message}`);
  }
};

export const createFileDocument = async ({
  userId,
  courseId,
  buffer,
  filename,
}: {
  userId: string;
  courseId: string;
  buffer: Buffer;
  filename: string;
}): Promise<{ document: SourceDocumentDocument; deduped: boolean }> => {
  if (buffer.length === 0) {
    throw new AppError('The file is empty.', { errorCode: 'CUSTOM_ERROR', statusCode: 400 });
  }

  const sniff = await sniffDocumentType({ buffer, filename });
  if (!sniff.ok) {
    throw new AppError('Unsupported or unrecognized file type.', {
      errorCode: 'UNSUPPORTED_FILE_TYPE',
      statusCode: 400,
      // Category-level only — safe to echo; never document content.
      meta: { reason: sniff.reason },
    });
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  // Audio: probe the duration from the container header (CPU-only, no
  // vendor call) so the ≤180-min/course A9 cap can gate ADMISSION — the
  // free ingest triage transcribes whole mp3/m4a files, so the cost bound
  // must exist before any audio row is accepted.
  const audioProbe = AUDIO_SNIFF_EXTS.has(sniff.detectedExt)
    ? probeAudioDuration({ buffer, mimeType: sniff.mimeType })
    : null;

  return withCourseLock(courseId, async () => {
    // Dedup within the course: an identical upload returns the existing
    // row untouched (idempotent), before any S3 write.
    const existing = await SourceDocumentModel.findOne({ courseId, kind: 'file', sha256 });
    if (existing) return { document: existing, deduped: true };

    const have = await SourceDocumentModel.countDocuments({ courseId, kind: 'file' });
    if (have >= MAX_FILES_PER_COURSE) {
      throw capError(MAX_FILES_PER_COURSE, have, 'files');
    }

    if (audioProbe?.durationSec !== undefined) {
      // Course audio budget: rows carry `audioDurationSec` from this
      // upload-time probe (authoritative extraction overwrites it at
      // ingest). Pre-fix rows and unprobeable files count 0 — approximate
      // by design, like every A9 cap.
      const audioRows = await SourceDocumentModel.find({ courseId, kind: 'file' })
        .select('audioDurationSec')
        .lean();
      const haveSec = audioRows.reduce((sum, d) => sum + (d.audioDurationSec ?? 0), 0);
      if (haveSec + audioProbe.durationSec > MAX_AUDIO_SECONDS_PER_COURSE) {
        const limitMin = Math.round(MAX_AUDIO_SECONDS_PER_COURSE / 60);
        const haveMin = Math.round(haveSec / 60);
        const fileMin = Math.max(1, Math.round(audioProbe.durationSec / 60));
        throw new AppError(
          `This course allows at most ${limitMin} minutes of audio; it already has ${haveMin} and this file adds ~${fileMin}. Remove audio or upload a shorter file.`,
          {
            errorCode: 'DOCUMENT_LIMIT_EXCEEDED',
            statusCode: 400,
            meta: { limit: limitMin, have: haveMin, fileMinutes: fileMin, unit: 'audio minutes' },
          },
        );
      }
    }

    const documentId = new mongoose.Types.ObjectId();
    const s3Key = documentS3Key({ userId, courseId, documentId });

    // S3 first, row second — a crash between the two leaves an orphaned
    // object (cleaned by prefix-wipe on course deletion), never a row
    // pointing at missing bytes.
    await uploadBuffer({ key: s3Key, body: buffer, contentType: sniff.mimeType });

    let document: SourceDocumentDocument;
    try {
      document = await SourceDocumentModel.create({
        _id: documentId,
        userId,
        courseId,
        kind: 'file',
        filename: filename.slice(0, 500),
        mimeType: sniff.mimeType,
        byteSize: buffer.length,
        sha256,
        s3Key,
        status: 'uploaded',
        // Upload-time probe feeds the course audio budget above; the
        // ingest extraction overwrites it with the authoritative value.
        ...(audioProbe?.durationSec !== undefined
          ? { audioDurationSec: Math.round(audioProbe.durationSec) }
          : {}),
        ...(audioProbe && audioProbe.durationSec === undefined
          ? { warnings: ['audio duration could not be determined at upload'] }
          : {}),
      });
    } catch (e) {
      await deleteS3ObjectQuietly(s3Key);
      // Unique {courseId, sha256} race (out-of-band writer): resolve to
      // the winning row — idempotent, not an error.
      if ((e as { code?: number }).code === 11000) {
        const winner = await SourceDocumentModel.findOne({ courseId, kind: 'file', sha256 });
        if (winner) return { document: winner, deduped: true };
      }
      throw e;
    }

    // Belt-and-braces recount for writers outside this process's lock
    // (the service is single-instance by design, so this should never
    // fire; if it does, roll our own insert back — fail closed).
    const total = await SourceDocumentModel.countDocuments({ courseId, kind: 'file' });
    if (total > MAX_FILES_PER_COURSE) {
      await SourceDocumentModel.deleteOne({ _id: documentId });
      await deleteS3ObjectQuietly(s3Key);
      throw capError(MAX_FILES_PER_COURSE, total - 1, 'files');
    }

    return { document, deduped: false };
  });
};

// ── Create (url) ───────────────────────────────────────────

export const createUrlDocument = async ({
  userId,
  courseId,
  url,
}: {
  userId: string;
  courseId: string;
  url: string;
}): Promise<{ document: SourceDocumentDocument; deduped: boolean }> => {
  const validated = validateSourceUrl(url);
  if (!validated.ok) {
    throw new AppError(validated.reason, { errorCode: 'CUSTOM_ERROR', statusCode: 400 });
  }
  const normalizedUrl = validated.url;

  return withCourseLock(courseId, async () => {
    const existing = await SourceDocumentModel.findOne({
      courseId,
      kind: 'url',
      sourceUrl: normalizedUrl,
    });
    if (existing) return { document: existing, deduped: true };

    const have = await SourceDocumentModel.countDocuments({ courseId, kind: 'url' });
    if (have >= MAX_URLS_PER_COURSE) {
      throw capError(MAX_URLS_PER_COURSE, have, 'URLs');
    }

    const documentId = new mongoose.Types.ObjectId();
    // No fetch in this phase — the ingest job fetches via Jina Reader and
    // writes the snapshot to this reserved key later. sha256 is the hash
    // of the normalized URL (a stable placeholder until snapshot bytes
    // exist; url-kind dedup rides on sourceUrl, not sha256).
    let document: SourceDocumentDocument;
    try {
      document = await SourceDocumentModel.create({
        _id: documentId,
        userId,
        courseId,
        kind: 'url',
        sourceUrl: normalizedUrl,
        filename: normalizedUrl.slice(0, 500),
        mimeType: 'text/html',
        byteSize: 0,
        sha256: crypto.createHash('sha256').update(normalizedUrl).digest('hex'),
        s3Key: documentS3Key({ userId, courseId, documentId }),
        status: 'uploaded',
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        const winner = await SourceDocumentModel.findOne({
          courseId,
          kind: 'url',
          sourceUrl: normalizedUrl,
        });
        if (winner) return { document: winner, deduped: true };
      }
      throw e;
    }

    const total = await SourceDocumentModel.countDocuments({ courseId, kind: 'url' });
    if (total > MAX_URLS_PER_COURSE) {
      await SourceDocumentModel.deleteOne({ _id: documentId });
      throw capError(MAX_URLS_PER_COURSE, total - 1, 'URLs');
    }

    return { document, deduped: false };
  });
};

// ── List / delete ──────────────────────────────────────────

export const listCourseDocuments = async ({
  courseId,
}: {
  courseId: string;
}): Promise<SourceDocumentDocument[]> => {
  // Bounded by the A9 caps (≤10 files + ≤10 URLs) — no pagination needed.
  return SourceDocumentModel.find({ courseId }).sort({ createdAt: 1, _id: 1 });
};

/**
 * Delete one document row + its raw S3 object. Caller must have resolved
 * course ownership already (`getUserCourseLean`); the query re-scopes by
 * courseId so a documentId from another course can never match.
 * Returns false when nothing matched (caller 404s).
 */
export const deleteSourceDocument = async ({
  courseId,
  documentId,
}: {
  courseId: string;
  documentId: string;
}): Promise<boolean> => {
  return withCourseLock(courseId, async () => {
    const doc = await SourceDocumentModel.findOneAndDelete({ _id: documentId, courseId });
    if (!doc) return false;
    // Row first, S3 second: a failed S3 delete leaves an orphaned object
    // that the course-deletion prefix wipe cleans up later.
    await deleteS3ObjectQuietly(doc.s3Key);
    if (doc.parsedS3Key && doc.parsedS3Key !== doc.s3Key) {
      await deleteS3ObjectQuietly(doc.parsedS3Key);
    }
    // Embeddings are derived personal data: an ingested document's chunk
    // rows + Pinecone vectors must not outlive the document row (Phase 4
    // erasure). Manifest-first inside; a failure leaves the chunk rows as
    // the retry manifest and the course/account cascades as the backstop.
    await deleteSourceChunksForDocument(documentId).catch((e) => {
      genLog.error(`sourceDocument: chunk cleanup failed for ${documentId}: ${(e as Error).message}`);
    });
    return true;
  });
};
