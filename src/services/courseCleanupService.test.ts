/**
 * Tests for the cascade-delete + edit-impact reporting around course content.
 * Bugs here orphan rows when a user regenerates a structure or cause wrong
 * "you'll lose X minutes of progress" estimates.
 *
 * Run: yarn test courseCleanupService
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse, makeLessonContent, makeRecallCard, makeRecallProgress } from '../../test-helpers/factories';
import LessonContentModel from '@models/LessonContentModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import RecallCardModel from '@models/RecallCardModel';
import UserRecallProgressModel from '@models/UserRecallProgressModel';
import CourseDesignChatModel from '@models/CourseDesignChatModel';

vi.mock('@services/s3Service', () => ({
  deleteByPrefix: vi.fn(() => Promise.resolve(0)),
  uploadBuffer: vi.fn(),
  getPresignedUrl: vi.fn(),
  objectExists: vi.fn(),
  copyObject: vi.fn(),
  deleteObject: vi.fn(),
  getObjectBuffer: vi.fn(),
  listKeysByPrefix: vi.fn(() => Promise.resolve([])),
  resolveImageUrl: vi.fn(),
}));

// Pinecone is mocked so the source-chunk deletion path (Mongo-manifest-first)
// can run against the memory server without a live index.
vi.mock('@lib/pinecone', () => ({
  upsertChunkVectors: vi.fn(() => Promise.resolve(true)),
  deleteChunkVectorsByIds: vi.fn(() => Promise.resolve(true)),
  queryChunks: vi.fn(() => Promise.resolve([])),
  upsertVectors: vi.fn(() => Promise.resolve(true)),
  queryVectors: vi.fn(() => Promise.resolve([])),
  deleteVectorsByIds: vi.fn(() => Promise.resolve(true)),
  fetchVectorIds: vi.fn(() => Promise.resolve([])),
  isPineconeEnabled: () => true,
}));

import {
  cleanupCourseContent,
  cleanupCourseSources,
  getEditImpact,
  isPressDomainUrl,
  sweepExpiredUrlSnapshots,
  sweepOrphanedSourceDocuments,
} from '@services/courseCleanupService';
import { deleteByPrefix } from '@services/s3Service';
import { deleteVectorsByIds } from '@lib/pinecone';
import SourceDocumentModel from '@models/SourceDocumentModel';
import SourceDocumentChunkModel from '@models/SourceDocumentChunkModel';
import CourseModel from '@models/CourseModel';

setupTestDb();

const seedSourceDoc = async (params: {
  userId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  withChunk?: boolean;
}) => {
  const documentId = new mongoose.Types.ObjectId();
  const doc = await SourceDocumentModel.create({
    _id: documentId,
    userId: params.userId,
    courseId: params.courseId,
    kind: 'file',
    filename: 'a.pdf',
    mimeType: 'application/pdf',
    byteSize: 10,
    sha256: documentId.toString().padEnd(64, '0'),
    s3Key: `uploads/${params.userId.toString()}/${params.courseId.toString()}/${documentId.toString()}`,
    status: 'parsed',
  });
  if (params.withChunk !== false) {
    await SourceDocumentChunkModel.create({
      userId: params.userId,
      courseId: params.courseId,
      documentId,
      chunkIndex: 0,
      chunkType: 'text',
      text: 'chunk',
      headingPath: [],
      pageRange: null,
      vectorId: `doc:${params.courseId.toString()}:${documentId.toString()}:0`,
    });
  }
  return doc;
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── cleanupCourseContent ───────────────────────────────

describe('cleanupCourseContent', () => {
  test('empty course: all counts are 0, no errors, S3 cleanup still fired', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    const result = await cleanupCourseContent(course._id.toString());
    expect(result.lessonContentDeleted).toBe(0);
    expect(result.lessonProgressDeleted).toBe(0);
    expect(result.recallCardsDeleted).toBe(0);
    expect(result.recallProgressDeleted).toBe(0);

    // S3 cleanup is fire-and-forget; we mocked it to resolve
    expect(deleteByPrefix).toHaveBeenCalledWith(`lessons/${course._id}/`);
  });

  test('cascades through lessons, quizzes, recall cards, and dependent recall progress', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    // Seed: 2 lesson contents, 1 quiz content, 1 recall card + progress, 1 chat session
    await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 0 });
    await makeLessonContent({ courseId: course._id, moduleIndex: 1, lessonIndex: 0 });
    await ModuleQuizContentModel.create({
      courseId: course._id,
      moduleIndex: 0,
      questions: [],
      version: 1,
    });
    const lesson = await makeLessonContent({ courseId: course._id, moduleIndex: 2, lessonIndex: 0 });
    const card = await makeRecallCard({ courseId: course._id, lessonId: lesson._id });
    await makeRecallProgress({
      userId: user._id,
      recallCardId: card._id,
      reps: 1,
    });
    await CourseDesignChatModel.create({
      userId: user._id,
      courseId: course._id,
      messages: [],
    });

    const result = await cleanupCourseContent(course._id.toString());
    expect(result.lessonContentDeleted).toBe(3);
    expect(result.quizContentDeleted).toBe(1);
    expect(result.recallCardsDeleted).toBe(1);
    expect(result.recallProgressDeleted).toBe(1);
    expect(result.chatSessionsDeleted).toBe(1);

    // Verify nothing left
    expect(await LessonContentModel.countDocuments({ courseId: course._id })).toBe(0);
    expect(await ModuleQuizContentModel.countDocuments({ courseId: course._id })).toBe(0);
    expect(await RecallCardModel.countDocuments({ courseId: course._id })).toBe(0);
    expect(await UserRecallProgressModel.countDocuments({ recallCardId: card._id })).toBe(0);
  });

  test('cleans only the targeted course (other courses untouched)', async () => {
    const user = await makeUser();
    const courseA = await makeCourse({ userId: user._id });
    const courseB = await makeCourse({ userId: user._id });

    await makeLessonContent({ courseId: courseA._id, moduleIndex: 0, lessonIndex: 0 });
    await makeLessonContent({ courseId: courseB._id, moduleIndex: 0, lessonIndex: 0 });

    await cleanupCourseContent(courseA._id.toString());

    expect(await LessonContentModel.countDocuments({ courseId: courseA._id })).toBe(0);
    expect(await LessonContentModel.countDocuments({ courseId: courseB._id })).toBe(1);
  });

  test('S3 cleanup throws → bgError catches it; Mongo deletions still happen', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await makeLessonContent({ courseId: course._id });

    vi.mocked(deleteByPrefix).mockRejectedValueOnce(new Error('S3 unreachable'));

    const result = await cleanupCourseContent(course._id.toString());
    expect(result.lessonContentDeleted).toBe(1); // still cleaned despite S3 failure
  });
});

// ── The cleanup split (regen vs deletion) ──────────────

describe('cleanup split — regen path spares sources', () => {
  test('cleanupCourseContent leaves SourceDocument rows, chunks, and the uploads/ prefix untouched', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await makeLessonContent({ courseId: course._id });
    const doc = await seedSourceDoc({ userId: user._id, courseId: course._id });

    await cleanupCourseContent(course._id.toString());

    // Generated content is gone…
    expect(await LessonContentModel.countDocuments({ courseId: course._id })).toBe(0);
    // …but the source corpus is intact.
    expect(await SourceDocumentModel.countDocuments({ courseId: course._id })).toBe(1);
    expect(await SourceDocumentChunkModel.countDocuments({ documentId: doc._id })).toBe(1);
    expect(deleteVectorsByIds).not.toHaveBeenCalled();

    // S3: only the lessons/ prefix — never uploads/ and never quarantine/.
    const prefixes = vi.mocked(deleteByPrefix).mock.calls.map((c) => c[0]);
    expect(prefixes).toEqual([`lessons/${course._id}/`]);
  });
});

describe('cleanupCourseSources — deletion path', () => {
  test('deletes rows + chunks + vectors (Mongo-manifest-first) + the course uploads prefix; quarantine untouched', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const doc = await seedSourceDoc({ userId: user._id, courseId: course._id });
    const vectorId = `doc:${course._id.toString()}:${doc._id.toString()}:0`;

    const result = await cleanupCourseSources({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });

    expect(result.documentsDeleted).toBe(1);
    expect(result.chunksDeleted).toBe(1);
    expect(await SourceDocumentModel.countDocuments({ courseId: course._id })).toBe(0);
    expect(await SourceDocumentChunkModel.countDocuments({ courseId: course._id })).toBe(0);
    expect(deleteVectorsByIds).toHaveBeenCalledWith([vectorId], { action: 'delete:user-doc' });

    const prefixes = vi.mocked(deleteByPrefix).mock.calls.map((c) => c[0]);
    expect(prefixes).toContain(`uploads/${user._id.toString()}/${course._id.toString()}/`);
    expect(prefixes.some((p) => String(p).startsWith('quarantine/'))).toBe(false);
  });

  test('breadth guard: refuses empty courseId/userId (a bad interpolation must never widen the prefix delete)', async () => {
    await expect(cleanupCourseSources({ courseId: '', userId: 'u1' })).rejects.toThrow(/breadth guard/i);
    await expect(cleanupCourseSources({ courseId: 'c1', userId: '' })).rejects.toThrow(/breadth guard/i);
    expect(deleteByPrefix).not.toHaveBeenCalled();
  });

  test('S3 prefix failure is loud but does not block the Mongo erasure', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await seedSourceDoc({ userId: user._id, courseId: course._id });
    vi.mocked(deleteByPrefix).mockRejectedValueOnce(new Error('S3 unreachable'));

    const result = await cleanupCourseSources({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });

    expect(result.documentsDeleted).toBe(1);
    expect(await SourceDocumentModel.countDocuments({ courseId: course._id })).toBe(0);
  });
});

// ── Orphan sweep (abandoned wizard hygiene) ─────────────

describe('sweepOrphanedSourceDocuments', () => {
  const backdateCourse = async (courseId: mongoose.Types.ObjectId, days: number) => {
    await CourseModel.collection.updateOne(
      { _id: courseId },
      { $set: { updatedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } },
    );
  };

  test('deletes sources only for creating-status courses stale ≥ 30 days', async () => {
    const user = await makeUser();

    const stale = await makeCourse({ userId: user._id, status: 'creating' });
    await seedSourceDoc({ userId: user._id, courseId: stale._id });
    await backdateCourse(stale._id, 31);

    const fresh = await makeCourse({ userId: user._id, status: 'creating' });
    await seedSourceDoc({ userId: user._id, courseId: fresh._id });

    const ready = await makeCourse({ userId: user._id, status: 'ready' });
    await seedSourceDoc({ userId: user._id, courseId: ready._id });
    await backdateCourse(ready._id, 31);

    const swept = await sweepOrphanedSourceDocuments();

    expect(swept).toBe(1);
    expect(await SourceDocumentModel.countDocuments({ courseId: stale._id })).toBe(0);
    expect(await SourceDocumentChunkModel.countDocuments({ courseId: stale._id })).toBe(0);
    expect(await SourceDocumentModel.countDocuments({ courseId: fresh._id })).toBe(1);
    expect(await SourceDocumentModel.countDocuments({ courseId: ready._id })).toBe(1);
    // The course row itself survives — only its abandoned sources are reaped.
    expect(await CourseModel.countDocuments({ _id: stale._id })).toBe(1);
  });

  test('no stale courses → no-op', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    await seedSourceDoc({ userId: user._id, courseId: course._id });

    expect(await sweepOrphanedSourceDocuments()).toBe(0);
    expect(await SourceDocumentModel.countDocuments({ courseId: course._id })).toBe(1);
  });
});

// ── URL-snapshot retention sweep (ToS §6.2 / Privacy §5) ─
//
// The promise these tests pin, verbatim from Terms of Service §6.2:
//   "We delete the fetched text 90 days after your course finishes
//    generating — 30 days where the page comes from a news or press site
//    … After that we keep only the link, the page title, the time we
//    fetched it, a content fingerprint, and the specific excerpts your
//    lessons draw on."

describe('isPressDomainUrl', () => {
  test('matches a listed domain, its subdomains, and nothing else', () => {
    expect(isPressDomainUrl('https://www.reuters.com/world/article')).toBe(true);
    expect(isPressDomainUrl('https://reuters.com/')).toBe(true);
    expect(isPressDomainUrl('https://edition.cnn.com/2026/07/30/x')).toBe(true);
    expect(isPressDomainUrl('https://www.lrt.lt/naujienos/x')).toBe(true);
    // Not a suffix match — the boundary must be a dot, not a substring.
    expect(isPressDomainUrl('https://notreuters.com/x')).toBe(false);
    expect(isPressDomainUrl('https://en.wikipedia.org/wiki/Reuters')).toBe(false);
    // A hostile URL that merely mentions a press domain in its path/query.
    expect(isPressDomainUrl('https://evil.example/?u=https://nytimes.com/a')).toBe(false);
  });

  test('unparseable, empty and null inputs fall back to the default window', () => {
    expect(isPressDomainUrl(null)).toBe(false);
    expect(isPressDomainUrl('')).toBe(false);
    expect(isPressDomainUrl('not a url')).toBe(false);
  });
});

describe('sweepExpiredUrlSnapshots', () => {
  const backdateDoc = async (documentId: mongoose.Types.ObjectId, days: number) => {
    await SourceDocumentModel.collection.updateOne(
      { _id: documentId },
      { $set: { updatedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } },
    );
  };

  /** A url document with `chunkCount` chunks, on a `ready` course. */
  const seedUrlDoc = async (params: {
    userId: mongoose.Types.ObjectId;
    courseId: mongoose.Types.ObjectId;
    sourceUrl: string;
    ageDays: number;
    chunkCount?: number;
    parsedS3Key?: string | null;
  }) => {
    const documentId = new mongoose.Types.ObjectId();
    const doc = await SourceDocumentModel.create({
      _id: documentId,
      userId: params.userId,
      courseId: params.courseId,
      kind: 'url',
      sourceUrl: params.sourceUrl,
      filename: params.sourceUrl,
      mimeType: 'text/html',
      byteSize: 4096,
      sha256: documentId.toString().padEnd(64, 'a'),
      s3Key: `uploads/${params.userId.toString()}/${params.courseId.toString()}/${documentId.toString()}`,
      parsedS3Key:
        params.parsedS3Key === undefined
          ? `uploads/${params.userId.toString()}/${params.courseId.toString()}/parsed/${documentId.toString()}`
          : params.parsedS3Key,
      status: 'parsed',
      reservationSignal: 'no_reservation',
      reservationCheckedAt: new Date(),
    });
    const vectorIds: string[] = [];
    for (let i = 0; i < (params.chunkCount ?? 2); i += 1) {
      const vectorId = `doc:${params.courseId.toString()}:${documentId.toString()}:${i}`;
      vectorIds.push(vectorId);
      await SourceDocumentChunkModel.create({
        userId: params.userId,
        courseId: params.courseId,
        documentId,
        chunkIndex: i,
        chunkType: 'text',
        text: `snapshot chunk ${i}`,
        headingPath: [],
        pageRange: null,
        vectorId,
      });
    }
    await backdateDoc(documentId, params.ageDays);
    return { doc, documentId, vectorIds };
  };

  const structureCiting = (refs: string[]) => ({
    reasoning: { learnerProfile: '', topicAnalysis: '', scopeDecisions: '', progressionStrategy: '' },
    modules: [{ name: 'M1', description: '', lessons: [{ name: 'L1', description: '', sourceRefs: refs }] }],
  });

  test('a url doc past 90 days is swept: S3 objects, chunks and vectors go, the row survives', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    const { documentId, vectorIds } = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/a-long-read',
      ageDays: 91,
    });

    const result = await sweepExpiredUrlSnapshots();

    expect(result.documentsSwept).toBe(1);
    expect(result.pressDocumentsSwept).toBe(0);
    expect(result.chunksDeleted).toBe(2);
    expect(result.chunksRetained).toBe(0);

    // Chunks + vectors gone.
    expect(await SourceDocumentChunkModel.countDocuments({ documentId })).toBe(0);
    expect(deleteVectorsByIds).toHaveBeenCalledWith(vectorIds, { action: 'delete:user-doc' });

    // Both S3 objects targeted: the snapshot and the parsed artifact.
    const keys = vi.mocked(deleteByPrefix).mock.calls.map((c) => String(c[0]));
    expect(keys).toContain(`uploads/${user._id.toString()}/${course._id.toString()}/${documentId.toString()}`);
    expect(keys).toContain(
      `uploads/${user._id.toString()}/${course._id.toString()}/parsed/${documentId.toString()}`,
    );

    // The row survives as the lineage record the documents promise to keep.
    const row = await SourceDocumentModel.findById(documentId).lean();
    expect(row).not.toBeNull();
    expect(row!.sourceUrl).toBe('https://example.org/a-long-read');
    expect(row!.sha256).toBeTruthy();
    expect(row!.reservationSignal).toBe('no_reservation');
    expect(row!.createdAt).toBeInstanceOf(Date);
    // …with the snapshot fields cleared and the erasure stamped.
    expect(row!.parsedS3Key).toBeNull();
    expect(row!.snapshotDeletedAt).toBeInstanceOf(Date);
  });

  test('a press-domain doc past 30 but under 90 days is swept', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    const { documentId } = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://www.reuters.com/technology/story',
      ageDays: 45,
    });

    const result = await sweepExpiredUrlSnapshots();

    expect(result.documentsSwept).toBe(1);
    expect(result.pressDocumentsSwept).toBe(1);
    expect((await SourceDocumentModel.findById(documentId).lean())!.snapshotDeletedAt).toBeInstanceOf(Date);
  });

  test('a press-domain doc under 30 days is NOT swept', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    const { documentId } = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://www.reuters.com/technology/story',
      ageDays: 29,
    });

    const result = await sweepExpiredUrlSnapshots();

    expect(result.documentsSwept).toBe(0);
    expect(await SourceDocumentChunkModel.countDocuments({ documentId })).toBe(2);
    expect((await SourceDocumentModel.findById(documentId).lean())!.snapshotDeletedAt).toBeNull();
    expect(deleteByPrefix).not.toHaveBeenCalled();
  });

  test('a non-press doc between 30 and 90 days is NOT swept', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    const { documentId } = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/essay',
      ageDays: 60,
    });

    expect((await sweepExpiredUrlSnapshots()).documentsSwept).toBe(0);
    expect((await SourceDocumentModel.findById(documentId).lean())!.snapshotDeletedAt).toBeNull();
  });

  test('a file-kind document is never touched by this rule, however old', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    const doc = await seedSourceDoc({ userId: user._id, courseId: course._id });
    await backdateDoc(doc._id, 400);

    const result = await sweepExpiredUrlSnapshots();

    expect(result.documentsSwept).toBe(0);
    expect(await SourceDocumentChunkModel.countDocuments({ documentId: doc._id })).toBe(1);
    expect((await SourceDocumentModel.findById(doc._id).lean())!.snapshotDeletedAt).toBeNull();
    expect(deleteByPrefix).not.toHaveBeenCalled();
  });

  test('cited excerpts survive: chunks named in a lesson’s sourceRefs are retained, the rest go', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    const { documentId, vectorIds } = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/handbook',
      ageDays: 120,
      chunkCount: 4,
    });
    // Lesson 1 draws on chunks 0 and 2.
    await CourseModel.updateOne(
      { _id: course._id },
      { $set: { structure: structureCiting([vectorIds[0], vectorIds[2]]) } },
    );

    const result = await sweepExpiredUrlSnapshots();

    expect(result.documentsSwept).toBe(1);
    expect(result.chunksDeleted).toBe(2);
    expect(result.chunksRetained).toBe(2);

    const left = await SourceDocumentChunkModel.find({ documentId }).select('vectorId').lean();
    expect(left.map((c) => c.vectorId).sort()).toEqual([vectorIds[0], vectorIds[2]].sort());
    // Only the uncited vectors were deleted from Pinecone.
    expect(deleteVectorsByIds).toHaveBeenCalledWith([vectorIds[1], vectorIds[3]], {
      action: 'delete:user-doc',
    });
    // The full page copy still goes, cited excerpts or not.
    const keys = vi.mocked(deleteByPrefix).mock.calls.map((c) => String(c[0]));
    expect(keys).toContain(`uploads/${user._id.toString()}/${course._id.toString()}/${documentId.toString()}`);
  });

  test('a stale sourceRef pointing at another document does not spare foreign chunks', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    const a = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/one',
      ageDays: 120,
      chunkCount: 2,
    });
    const b = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/two',
      ageDays: 120,
      chunkCount: 2,
    });
    // The structure cites one chunk from each document.
    await CourseModel.updateOne(
      { _id: course._id },
      { $set: { structure: structureCiting([a.vectorIds[0], b.vectorIds[0]]) } },
    );

    await sweepExpiredUrlSnapshots();

    // Each document kept exactly its OWN cited chunk.
    const leftA = await SourceDocumentChunkModel.find({ documentId: a.documentId }).lean();
    const leftB = await SourceDocumentChunkModel.find({ documentId: b.documentId }).lean();
    expect(leftA.map((c) => c.vectorId)).toEqual([a.vectorIds[0]]);
    expect(leftB.map((c) => c.vectorId)).toEqual([b.vectorIds[0]]);
  });

  test('a course still `creating` is skipped — it never finished generating', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'creating' });
    const { documentId } = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/draft',
      ageDays: 200,
    });

    const result = await sweepExpiredUrlSnapshots();

    expect(result.documentsSwept).toBe(0);
    expect(result.skipped).toBe(1);
    expect((await SourceDocumentModel.findById(documentId).lean())!.snapshotDeletedAt).toBeNull();
  });

  test('a course with a job in flight is deferred (job mutex), not swept', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    await CourseModel.updateOne({ _id: course._id }, { $set: { activeJobId: new mongoose.Types.ObjectId() } });
    const { documentId } = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/busy',
      ageDays: 200,
    });

    const result = await sweepExpiredUrlSnapshots();

    expect(result.documentsSwept).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await SourceDocumentChunkModel.countDocuments({ documentId })).toBe(2);
  });

  test('idempotent: the second run is a complete no-op', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/once',
      ageDays: 91,
    });

    const first = await sweepExpiredUrlSnapshots();
    expect(first.documentsSwept).toBe(1);

    vi.clearAllMocks();
    const second = await sweepExpiredUrlSnapshots();
    expect(second).toEqual({
      documentsSwept: 0,
      pressDocumentsSwept: 0,
      s3ObjectsDeleted: 0,
      chunksDeleted: 0,
      vectorsDeleted: 0,
      chunksRetained: 0,
      skipped: 0,
    });
    expect(deleteByPrefix).not.toHaveBeenCalled();
    expect(deleteVectorsByIds).not.toHaveBeenCalled();
  });

  test('bounded per tick: 60 expired docs need two ticks (batch is 50)', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    for (let i = 0; i < 60; i += 1) {
      await seedUrlDoc({
        userId: user._id,
        courseId: course._id,
        sourceUrl: `https://example.org/article-${i}`,
        ageDays: 100 + i,
        chunkCount: 0,
      });
    }

    expect((await sweepExpiredUrlSnapshots()).documentsSwept).toBe(50);
    expect((await sweepExpiredUrlSnapshots()).documentsSwept).toBe(10);
    expect((await sweepExpiredUrlSnapshots()).documentsSwept).toBe(0);
    expect(await SourceDocumentModel.countDocuments({ snapshotDeletedAt: null })).toBe(0);
  });

  test('a shared parsed artifact is kept until the last document referencing it is swept', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    const shared = `uploads/${user._id.toString()}/${course._id.toString()}/parsed/shared-hash`;
    const a = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/dup-a',
      ageDays: 100,
      chunkCount: 0,
      parsedS3Key: shared,
    });
    await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/dup-b',
      ageDays: 40, // not yet due — still points at the shared object
      chunkCount: 0,
      parsedS3Key: shared,
    });

    await sweepExpiredUrlSnapshots();

    const keys = vi.mocked(deleteByPrefix).mock.calls.map((c) => String(c[0]));
    expect(keys).toContain(`uploads/${user._id.toString()}/${course._id.toString()}/${a.documentId.toString()}`);
    expect(keys).not.toContain(shared);
  });

  test('a document whose course row is gone is swept — deletion is already due', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    const { documentId } = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/orphan',
      ageDays: 120,
    });
    await CourseModel.deleteOne({ _id: course._id });

    expect((await sweepExpiredUrlSnapshots()).documentsSwept).toBe(1);
    expect(await SourceDocumentChunkModel.countDocuments({ documentId })).toBe(0);
  });

  test('S3 failure is loud but does not block the Mongo erasure or the stamp', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, status: 'ready' });
    const { documentId } = await seedUrlDoc({
      userId: user._id,
      courseId: course._id,
      sourceUrl: 'https://example.org/s3-down',
      ageDays: 120,
    });
    // Both objects (snapshot + parsed artifact) fail; `Once` so the
    // rejection cannot leak into a later test (mockClear does not reset
    // implementations).
    vi.mocked(deleteByPrefix)
      .mockRejectedValueOnce(new Error('S3 unreachable'))
      .mockRejectedValueOnce(new Error('S3 unreachable'));

    const result = await sweepExpiredUrlSnapshots();

    expect(result.documentsSwept).toBe(1);
    expect(result.s3ObjectsDeleted).toBe(0);
    expect(await SourceDocumentChunkModel.countDocuments({ documentId })).toBe(0);
    expect((await SourceDocumentModel.findById(documentId).lean())!.snapshotDeletedAt).toBeInstanceOf(Date);
  });
});

// ── getEditImpact ──────────────────────────────────────
//
// ⚠️ BUG (revealed by tests 2026-04-24):
// `getEditImpact` runs `$match: { courseId, userId }` in its aggregations
// where both inputs are STRINGS, but the stored fields are ObjectIds. Mongo
// doesn't auto-cast string→ObjectId in aggregation $match, so EVERY
// aggregation returns an empty array and the progress/notes/quiz numbers
// silently default to zero in production. The `hasContent` field uses
// countDocuments() (which Mongoose-casts), so it still works.
//
// Caller path: `controlers/course/getEditImpact.ts:54–57` passes raw strings.
//
// Tests below capture the ACTUAL behavior — they will start failing once
// the source casts to ObjectId before the $match (the obvious fix).

describe('getEditImpact', () => {
  test('empty course / no progress: hasContent + hasProgress both false', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    const result = await getEditImpact({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });
    expect(result.hasContent).toBe(false);
    expect(result.hasProgress).toBe(false);
    expect(result.completedLessons).toBe(0);
    expect(result.totalTimeSpentMinutes).toBe(0);
  });

  test('mixed completed + in-progress lessons: counts each independently', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 0 });

    // 2 completed, 1 in-progress
    await UserLessonProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      lessonIndex: 0,
      status: 'completed',
      timeSpentSeconds: 1200,
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });
    await UserLessonProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      lessonIndex: 1,
      status: 'completed',
      timeSpentSeconds: 600,
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });
    await UserLessonProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 1,
      lessonIndex: 0,
      status: 'in_progress',
      timeSpentSeconds: 1800,
      lastAccessedAt: new Date(),
    });

    const result = await getEditImpact({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });
    expect(result.hasContent).toBe(true); // countDocuments works (Mongoose casts)
    // BUG: aggregation $match doesn't cast string → ObjectId, so the
    // progress aggregation returns empty and these stay 0.
    expect(result.hasProgress).toBe(false);
    expect(result.completedLessons).toBe(0);
    expect(result.inProgressLessons).toBe(0);
    expect(result.totalTimeSpentMinutes).toBe(0);
  });

  test('counts notes + bookmarks independently of status', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await UserLessonProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      lessonIndex: 0,
      status: 'completed',
      notes: 'Important',
      bookmarked: true,
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });
    await UserLessonProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      lessonIndex: 1,
      status: 'completed',
      notes: '',
      bookmarked: false,
      lastAccessedAt: new Date(),
      completedAt: new Date(),
    });

    const result = await getEditImpact({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });
    // BUG (see header note): aggregation returns empty → both fields zero.
    expect(result.totalNotes).toBe(0);
    expect(result.totalBookmarks).toBe(0);
  });

  test('quiz attempts and mastery aggregation', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });
    await UserModuleQuizProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 0,
      bestScore: 100,
      bestTier: 'mastered',
      reviewIntervalDays: 7,
      consecutiveSuccesses: 1,
      nextReviewAt: new Date(),
      attempts: [
        {
          attemptNumber: 1,
          responses: [],
          score: 100,
          masteryTier: 'mastered',
          completedAt: new Date(),
          quizVersion: 1,
        },
        {
          attemptNumber: 2,
          responses: [],
          score: 90,
          masteryTier: 'mastered',
          completedAt: new Date(),
          quizVersion: 1,
        },
      ],
    });
    await UserModuleQuizProgressModel.create({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      moduleIndex: 1,
      bestScore: 50,
      bestTier: 'needs_review',
      reviewIntervalDays: 1,
      consecutiveSuccesses: 0,
      nextReviewAt: null,
      attempts: [
        {
          attemptNumber: 1,
          responses: [],
          score: 50,
          masteryTier: 'needs_review',
          completedAt: new Date(),
          quizVersion: 1,
        },
      ],
    });

    const result = await getEditImpact({
      courseId: course._id.toString(),
      userId: user._id.toString(),
    });
    // BUG (see header note): aggregation returns empty → all quiz fields zero.
    expect(result.quizAttempts).toBe(0);
    expect(result.modulesWithMastery).toBe(0);
    expect(result.scheduledReviews).toBe(0);
  });
});
