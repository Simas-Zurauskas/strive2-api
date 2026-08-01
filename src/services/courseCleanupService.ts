import CourseDesignChatModel from '@models/CourseDesignChatModel';
import CourseMentorChatModel from '@models/CourseMentorChatModel';
import CourseModel from '@models/CourseModel';
import LessonContentModel from '@models/LessonContentModel';
import LessonMentorChatModel from '@models/LessonMentorChatModel';
import SourceDocumentModel from '@models/SourceDocumentModel';
import UserLessonProgressModel from '@models/UserLessonProgressModel';
import ModuleQuizContentModel from '@models/ModuleQuizContentModel';
import UserModuleQuizProgressModel from '@models/UserModuleQuizProgressModel';
import RecallCardModel from '@models/RecallCardModel';
import UserRecallProgressModel from '@models/UserRecallProgressModel';
import SourceDocumentChunkModel from '@models/SourceDocumentChunkModel';
import { deleteByPrefix } from '@services/s3Service';
import { deleteLessonChunksForCourse } from '@services/lessonRagService';
import {
  deleteSourceChunksForCourse,
  deleteSourceChunksForDocumentExcept,
} from '@services/sourceDocRagService';
import { bgError } from '@lib/bg';
import { captureError } from '@lib/errorReporter';
import {
  PRESS_DOMAIN_SUFFIXES,
  URL_SNAPSHOT_PRESS_RETENTION_DAYS,
  URL_SNAPSHOT_RETENTION_DAYS,
} from '@lib/constants';
import { jobLog, integrationLog } from '@lib/loggers';

export interface CleanupResult {
  chatSessionsDeleted: number;
  mentorChatsDeleted: number;
  courseMentorChatsDeleted: number;
  lessonContentDeleted: number;
  lessonProgressDeleted: number;
  quizContentDeleted: number;
  quizProgressDeleted: number;
  recallCardsDeleted: number;
  recallProgressDeleted: number;
  ragChunksDeleted: number;
  ragVectorsDeleted: number;
}

/**
 * Deletes all GENERATED content and user progress for a course.
 * Used when course structure changes (regeneration, refinement, edit mode)
 * to prevent orphaned data keyed by stale module/lesson indices.
 *
 * ⚠ THE CLEANUP SPLIT (course-from-documents Phase 4): this function is
 * called by the REGEN paths (clarify / depth-previews / structure / refine
 * jobs + the design-chat modify tool) *and*, together with
 * `cleanupCourseSources`, by the DELETION paths. It must therefore NEVER
 * touch the user's SOURCE material: SourceDocument rows,
 * SourceDocumentChunk rows, their `user-doc` Pinecone vectors, the
 * `uploads/{userId}/{courseId}/` S3 prefix, or `course.sourceAssessment` /
 * `course.sourceDigest` — a clarify re-run would otherwise wipe the very
 * corpus the design stages are about to consume. Source erasure lives
 * exclusively in `cleanupCourseSources` below.
 */
export const cleanupCourseContent = async (courseId: string): Promise<CleanupResult> => {
  // Grab recall card ids first so we can cascade to UserRecallProgress before
  // deleting the recall card rows themselves.
  const recallCardIdDocs = await RecallCardModel.find({ courseId }).select('_id').lean();
  const recallCardIds = recallCardIdDocs.map((d) => d._id);

  const [
    chatSessions,
    mentorChats,
    courseMentorChats,
    lessonContent,
    lessonProgress,
    quizContent,
    quizProgress,
    recallCards,
    recallProgress,
    ragCleanup,
  ] = await Promise.all([
    CourseDesignChatModel.deleteMany({ courseId }),
    LessonMentorChatModel.deleteMany({ courseId }),
    // CourseMentorChatModel was added after the original cleanup wiring
    // landed and was missing from the cascade — leaving rows orphaned on
    // course deletion. Caught by the audit; one-line fix.
    CourseMentorChatModel.deleteMany({ courseId }),
    LessonContentModel.deleteMany({ courseId }),
    UserLessonProgressModel.deleteMany({ courseId }),
    ModuleQuizContentModel.deleteMany({ courseId }),
    UserModuleQuizProgressModel.deleteMany({ courseId }),
    RecallCardModel.deleteMany({ courseId }),
    recallCardIds.length > 0
      ? UserRecallProgressModel.deleteMany({ recallCardId: { $in: recallCardIds } })
      : Promise.resolve({ deletedCount: 0 }),
    // RAG cleanup wraps Mongo + Pinecone deletions; failure logs but doesn't
    // abort the rest of the cleanup. Returning zero counts on error means
    // a future re-cleanup is harmless (idempotent).
    deleteLessonChunksForCourse(courseId).catch((e) => {
      bgError('courseCleanup.rag')(e);
      return { chunksDeleted: 0, vectorsDeleted: 0 };
    }),
  ]);

  // S3 cleanup (hero images, future assets) — fire and forget
  deleteByPrefix(`lessons/${courseId}/`)
    .then((count) => {
      if (count > 0) integrationLog.info(`s3:deletePrefix prefix=lessons/${courseId}/ deleted=${count}`);
    })
    .catch(bgError('courseCleanup.s3'));

  const result: CleanupResult = {
    chatSessionsDeleted: chatSessions.deletedCount,
    mentorChatsDeleted: mentorChats.deletedCount,
    courseMentorChatsDeleted: courseMentorChats.deletedCount,
    lessonContentDeleted: lessonContent.deletedCount,
    lessonProgressDeleted: lessonProgress.deletedCount,
    quizContentDeleted: quizContent.deletedCount,
    quizProgressDeleted: quizProgress.deletedCount,
    recallCardsDeleted: recallCards.deletedCount,
    recallProgressDeleted: recallProgress.deletedCount ?? 0,
    ragChunksDeleted: ragCleanup.chunksDeleted,
    ragVectorsDeleted: ragCleanup.vectorsDeleted,
  };

  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total > 0) {
    jobLog.info(
      `cleanup:course course=${courseId} total=${total} ` +
        `chats=${result.chatSessionsDeleted} mentor=${result.mentorChatsDeleted} ` +
        `lessons=${result.lessonContentDeleted} progress=${result.lessonProgressDeleted} ` +
        `quiz=${result.quizContentDeleted}/${result.quizProgressDeleted} ` +
        `recallCards=${result.recallCardsDeleted}/${result.recallProgressDeleted} ` +
        `rag=${result.ragChunksDeleted}/${result.ragVectorsDeleted}`,
    );
  }

  return result;
};

// ── Source cleanup (deletion paths ONLY — see the split note above) ──

export interface SourceCleanupResult {
  documentsDeleted: number;
  chunksDeleted: number;
  vectorsDeleted: number;
  s3ObjectsDeleted: number;
}

/**
 * Erases a course's SOURCE material: SourceDocument rows, chunk rows +
 * their Pinecone vectors (Mongo-manifest-first — the chunk rows are the
 * only way to enumerate the vector ids), and the whole
 * `uploads/{userId}/{courseId}/` S3 prefix (raw files, URL snapshots AND
 * the `parsed/` artifacts, which are pinned inside this prefix by design).
 *
 * Callers: deleteCourse + deleteAccount (both run this ALONGSIDE
 * `cleanupCourseContent`) and the orphan sweep below. Regen paths must
 * never call this.
 *
 * NEVER touches `quarantine/` — that prefix sits outside `uploads/` by
 * design (REPORT Act evidence retention, see hashScreen.ts).
 *
 * S3 failure is loud (error log + Sentry) but non-fatal: the user's
 * right to erasure on our primary stores must not be blocked by an S3
 * blip; the residue is retried by the account-deletion `uploads/{userId}/`
 * wipe or by ops on alarm.
 */
export const cleanupCourseSources = async ({
  courseId,
  userId,
}: {
  courseId: string;
  userId: string;
}): Promise<SourceCleanupResult> => {
  // Breadth guard: an empty segment would widen the prefix delete to
  // `uploads//` or `uploads/{userId}//` — refuse loudly (data-integrity
  // §11; one bad interpolation must never wipe other users' uploads).
  if (!courseId?.trim() || !userId?.trim()) {
    throw new Error('cleanupCourseSources: breadth guard — courseId and userId are both required');
  }

  const rag = await deleteSourceChunksForCourse(courseId);
  const docs = await SourceDocumentModel.deleteMany({ courseId });

  let s3ObjectsDeleted = 0;
  const prefix = `uploads/${userId}/${courseId}/`;
  try {
    s3ObjectsDeleted = await deleteByPrefix(prefix);
  } catch (e) {
    integrationLog.error(`cleanup:sources s3-prefix-failed prefix=${prefix} msg=${(e as Error).message}`);
    captureError(e, { tags: { source: 'courseCleanup.sources' }, extra: { prefix, courseId } });
  }

  const result: SourceCleanupResult = {
    documentsDeleted: docs.deletedCount,
    chunksDeleted: rag.chunksDeleted,
    vectorsDeleted: rag.vectorsDeleted,
    s3ObjectsDeleted,
  };

  if (result.documentsDeleted + result.chunksDeleted + result.s3ObjectsDeleted > 0) {
    jobLog.info(
      `cleanup:sources course=${courseId} docs=${result.documentsDeleted} chunks=${result.chunksDeleted} vectors=${result.vectorsDeleted} s3=${result.s3ObjectsDeleted}`,
    );
  }
  return result;
};

// ── Orphaned-source sweep (abandoned wizards, plan §5 data hygiene) ──
//
// A user who uploads documents and abandons the wizard leaves raw files,
// chunk rows and vectors attached to a course stuck in `creating`. This
// sweep reaps the SOURCES (not the course row — drafts stay resumable as
// goal courses) once the course has seen no activity for 30 days
// (Course.updatedAt — every wizard PATCH and job claim bumps it).
// Runs at boot + daily, the startStuckJobWatchdog idiom: unref'd interval,
// bounded batch per tick, loud counts.

const ORPHAN_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const ORPHAN_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days of no activity
const ORPHAN_SWEEP_BATCH = 20; // courses per tick — the next tick picks up the rest

export const sweepOrphanedSourceDocuments = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - ORPHAN_STALE_MS);

  // Only courses that actually have source documents are candidates.
  const courseIds = await SourceDocumentModel.distinct('courseId');
  if (courseIds.length === 0) return 0;

  const staleCourses = await CourseModel.find({
    _id: { $in: courseIds },
    status: 'creating',
    updatedAt: { $lt: cutoff },
  })
    .select('_id userId')
    .limit(ORPHAN_SWEEP_BATCH)
    .lean();

  for (const course of staleCourses) {
    await cleanupCourseSources({
      courseId: course._id.toString(),
      userId: course.userId.toString(),
    }).catch(bgError('sourceOrphanSweep.cleanup'));
  }

  if (staleCourses.length > 0) {
    jobLog.info(`cleanup:orphan-sources swept=${staleCourses.length} cutoff=${cutoff.toISOString()}`);
  }
  return staleCourses.length;
};

// ── URL-snapshot retention sweep (ToS §6.2 / Privacy §5) ──
//
// THE PROMISE, verbatim (Terms of Service §6.2):
//
//   "We keep the copy for a limited time. We delete the fetched text 90
//    days after your course finishes generating — 30 days where the page
//    comes from a news or press site — or as soon as you delete the
//    document, the course or your account, whichever comes first. After
//    that we keep only the link, the page title, the time we fetched it, a
//    content fingerprint, and the specific excerpts your lessons draw on."
//
// Privacy Policy §5 says the same and adds "the rights-reservation signal
// we read before fetching" to the keep-list. Both were published with an
// effective date of 1 Aug 2026; this sweep is what makes them true.
//
// The keep-list maps one-to-one onto columns that survive here:
//   the link            → SourceDocument.sourceUrl
//   the page title      → SourceDocument.filename  (see the caveat below)
//   the time we fetched → SourceDocument.createdAt
//   a content fingerprint → SourceDocument.sha256
//   the reservation signal → reservationSignal + reservationCheckedAt
//   the specific excerpts your lessons draw on
//                       → the SourceDocumentChunk rows whose vectorId is
//                         cited by some lesson's `sourceRefs`
// …which is why the ROW SURVIVES. Deleting it would delete six of the
// seven things we just published a promise to keep, and would erase the
// course's own record of where it came from.
//
// CAVEAT recorded rather than papered over: for a url document `filename`
// holds the submitted URL, not the page's <title> — we never store a page
// title. We therefore keep LESS than the sentence claims, never more, so
// no retention promise is breached; the sentence is simply generous about
// one field. Flagged for the next legal-text pass.
//
// WHAT IS ERASED, per document:
//   1. every chunk NOT cited by a lesson, plus its Pinecone vector
//      (manifest-first, via `deleteSourceChunksForDocumentExcept`)
//   2. the S3 snapshot at `s3Key` (the fetched page text)
//   3. the parsed artifact at `parsedS3Key`, unless another document in
//      the same course still points at it (the key is content-hashed, so
//      two identical pages share one object)
//   4. `parsedS3Key` is nulled and `snapshotDeletedAt` stamped — the CAS
//      that makes a second pass a no-op.
// `s3Key` is deliberately RETAINED: it is a deterministic function of
// (userId, courseId, documentId) that holds no content, and the ingest job
// re-uses it as the write target if the user ever re-runs ingest on this
// document. `snapshotDeletedAt` is the authoritative "the bytes are gone"
// marker, not the presence of a key string.

const URL_SNAPSHOT_SWEEP_BATCH = 50; // documents per age class per tick
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Is this URL's host one of the hand-listed press domains (see
 * `PRESS_DOMAIN_SUFFIXES` — non-exhaustive by design)? Anything
 * unrecognised, unparseable or null answers `false` and takes the default
 * 90-day window, which is the promise we make when we say nothing else.
 */
export const isPressDomainUrl = (sourceUrl: string | null | undefined): boolean => {
  if (!sourceUrl) return false;
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return PRESS_DOMAIN_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

export interface UrlSnapshotSweepResult {
  /** Documents whose snapshot was erased on this tick. */
  documentsSwept: number;
  /** Of those, how many matched a press domain (30-day window). */
  pressDocumentsSwept: number;
  s3ObjectsDeleted: number;
  chunksDeleted: number;
  vectorsDeleted: number;
  /** Cited excerpts deliberately kept (the promise's keep-list). */
  chunksRetained: number;
  /** Candidates deferred — course still generating, or a job is running. */
  skipped: number;
}

const EMPTY_URL_SWEEP: UrlSnapshotSweepResult = {
  documentsSwept: 0,
  pressDocumentsSwept: 0,
  s3ObjectsDeleted: 0,
  chunksDeleted: 0,
  vectorsDeleted: 0,
  chunksRetained: 0,
  skipped: 0,
};

/**
 * Collect every chunk vectorId the course's structure cites as grounding a
 * lesson. `structure` is `Schema.Types.Mixed`, so every level is validated
 * defensively — a malformed structure must degrade to "cite nothing"
 * (delete more), never to "cite everything" (delete nothing).
 */
const collectCitedVectorIds = (structure: unknown): Set<string> => {
  const cited = new Set<string>();
  const modules = (structure as { modules?: unknown } | null)?.modules;
  if (!Array.isArray(modules)) return cited;
  for (const mod of modules) {
    const lessons = (mod as { lessons?: unknown } | null)?.lessons;
    if (!Array.isArray(lessons)) continue;
    for (const lesson of lessons) {
      const refs = (lesson as { sourceRefs?: unknown } | null)?.sourceRefs;
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) if (typeof ref === 'string' && ref) cited.add(ref);
    }
  }
  return cited;
};

/** Prefix-scoped, non-throwing S3 delete. Returns objects actually removed. */
const deleteSnapshotObject = async (key: string | null): Promise<number> => {
  // Breadth guard: only ever inside the uploads tree, never a bare prefix.
  if (!key || !key.startsWith('uploads/') || key.endsWith('/')) return 0;
  try {
    return await deleteByPrefix(key);
  } catch (e) {
    integrationLog.error(`cleanup:url-snapshots s3-failed key=${key} msg=${(e as Error).message}`);
    captureError(e, { tags: { source: 'urlSnapshotSweep.s3' }, extra: { key } });
    return 0;
  }
};

/**
 * Delete fetched page snapshots that have outlived the published window.
 *
 * ANCHOR — a deviation worth knowing about. The documents say "90 days
 * after your course finishes generating", but no course-completion
 * timestamp exists (`Course` has `status` and `updatedAt`; `updatedAt` is
 * bumped by ordinary study activity, so it can never expire an active
 * course). Creating one would mean writing into the generation pipeline.
 * We therefore anchor on `SourceDocument.updatedAt` — the moment the
 * snapshot itself was last written by ingest. Ingest always precedes
 * structure generation, so this anchor is never LATER than the promised
 * one: we may delete a little early, never late. Deleting early cannot
 * breach the promise (the snapshot is never shown to the user by design)
 * and cannot strand a lesson, because cited excerpts are retained.
 *
 * Only courses that actually finished generating are in scope — a course
 * still in `creating` never triggered the promise, and its abandoned
 * sources are owned by `sweepOrphanedSourceDocuments` above (30 days).
 *
 * MUTEX: documents on a course with a live `activeJobId` are skipped
 * wholesale, so the sweep can never race an ingest/prepare-corpus run
 * that is re-writing the very snapshot it is deleting. The per-course
 * write lock in `sourceDocumentService` guards cap-checked writes, which
 * this sweep does not perform (it changes no counts and deletes no rows).
 *
 * Idempotent (`snapshotDeletedAt` CAS), bounded (two age classes ×
 * `URL_SNAPSHOT_SWEEP_BATCH`), and loud about its counts.
 */
export const sweepExpiredUrlSnapshots = async (): Promise<UrlSnapshotSweepResult> => {
  const now = Date.now();
  const defaultCutoff = new Date(now - URL_SNAPSHOT_RETENTION_DAYS * DAY_MS);
  const pressCutoff = new Date(now - URL_SNAPSHOT_PRESS_RETENTION_DAYS * DAY_MS);

  // Two bounded queries rather than one, so a backlog of not-yet-due
  // 90-day candidates can never starve press documents that are already
  // due at 30. Oldest first inside each class.
  const [overDefault, pressWindow] = await Promise.all([
    // Class A: past the default window — press or not, these are due.
    SourceDocumentModel.find({
      kind: 'url',
      snapshotDeletedAt: null,
      updatedAt: { $lt: defaultCutoff },
    })
      .sort({ updatedAt: 1 })
      .limit(URL_SNAPSHOT_SWEEP_BATCH)
      .lean(),
    // Class B: inside the 30–90 day band — due only for press domains.
    SourceDocumentModel.find({
      kind: 'url',
      snapshotDeletedAt: null,
      updatedAt: { $lt: pressCutoff, $gte: defaultCutoff },
    })
      .sort({ updatedAt: 1 })
      .limit(URL_SNAPSHOT_SWEEP_BATCH)
      .lean(),
  ]);

  const candidates = [...overDefault, ...pressWindow.filter((d) => isPressDomainUrl(d.sourceUrl))];
  if (candidates.length === 0) return EMPTY_URL_SWEEP;

  // One read for every course involved — status gate, job mutex, and the
  // cited-excerpt keep-list all come from here.
  const courseIds = [...new Set(candidates.map((d) => d.courseId.toString()))];
  const courses = await CourseModel.find({ _id: { $in: courseIds } })
    .select('_id status activeJobId structure')
    .lean();
  const courseById = new Map(courses.map((c) => [c._id.toString(), c]));
  const citedByCourse = new Map<string, Set<string>>();

  const result: UrlSnapshotSweepResult = { ...EMPTY_URL_SWEEP };

  for (const doc of candidates) {
    const courseId = doc.courseId.toString();
    const course = courseById.get(courseId);

    // A course row that is gone means deletion is already due under the
    // "or as soon as you delete … the course" branch — sweep it. But a
    // course still generating, or one with a job in flight, is deferred.
    if (course) {
      if (course.status === 'creating' || course.activeJobId) {
        result.skipped += 1;
        continue;
      }
      if (!citedByCourse.has(courseId)) {
        citedByCourse.set(courseId, collectCitedVectorIds(course.structure));
      }
    }

    const documentId = String(doc._id);
    const cited = citedByCourse.get(courseId) ?? new Set<string>();

    // Only ids that are really this document's chunks — a stale ref from a
    // deleted sibling must not widen the $nin and spare foreign rows.
    const ownChunks = await SourceDocumentChunkModel.find({ documentId: doc._id })
      .select('vectorId')
      .lean();
    const keep = ownChunks.map((c) => c.vectorId).filter((v) => cited.has(v));

    const rag = await deleteSourceChunksForDocumentExcept(documentId, keep).catch((e) => {
      bgError('urlSnapshotSweep.chunks')(e);
      return { chunksDeleted: 0, vectorsDeleted: 0 };
    });

    let s3Deleted = await deleteSnapshotObject(doc.s3Key);

    // The parsed key is content-hashed within the course, so an identical
    // page submitted under two URLs shares one object. Only delete it once
    // nothing else in the course still points at it.
    if (doc.parsedS3Key && doc.parsedS3Key !== doc.s3Key) {
      const sharers = await SourceDocumentModel.countDocuments({
        courseId: doc.courseId,
        parsedS3Key: doc.parsedS3Key,
        _id: { $ne: doc._id },
      });
      if (sharers === 0) s3Deleted += await deleteSnapshotObject(doc.parsedS3Key);
    }

    // Stamped LAST and conditionally: a crash before this point leaves the
    // row unmarked and the next tick simply retries (all steps above are
    // idempotent). The `snapshotDeletedAt: null` filter is the CAS that
    // makes a concurrent second sweep a no-op.
    const marked = await SourceDocumentModel.updateOne(
      { _id: doc._id, snapshotDeletedAt: null },
      { $set: { snapshotDeletedAt: new Date(), parsedS3Key: null } },
    );
    if (marked.modifiedCount === 0) continue;

    result.documentsSwept += 1;
    if (isPressDomainUrl(doc.sourceUrl)) result.pressDocumentsSwept += 1;
    result.s3ObjectsDeleted += s3Deleted;
    result.chunksDeleted += rag.chunksDeleted;
    result.vectorsDeleted += rag.vectorsDeleted;
    result.chunksRetained += keep.length;
  }

  if (result.documentsSwept > 0 || result.skipped > 0) {
    jobLog.info(
      `cleanup:url-snapshots swept=${result.documentsSwept} press=${result.pressDocumentsSwept} ` +
        `s3=${result.s3ObjectsDeleted} chunks=${result.chunksDeleted} vectors=${result.vectorsDeleted} ` +
        `retained=${result.chunksRetained} skipped=${result.skipped} ` +
        `cutoff=${defaultCutoff.toISOString()} pressCutoff=${pressCutoff.toISOString()}`,
    );
  }
  return result;
};

// ── Scheduler (one timer for both source sweeps) ──────────

let orphanSweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Both source-hygiene sweeps, run in sequence off one timer. Sequential,
 * not parallel: the orphan sweep can delete SourceDocument rows outright,
 * and running the retention sweep after it means the retention pass never
 * works on rows that are about to disappear.
 */
const runSourceDocumentSweeps = async (): Promise<void> => {
  await sweepOrphanedSourceDocuments().catch(bgError('sourceOrphanSweep.orphans'));
  await sweepExpiredUrlSnapshots().catch(bgError('sourceOrphanSweep.urlSnapshots'));
};

export const startSourceDocumentOrphanSweep = (): void => {
  if (orphanSweepTimer) return;
  // Boot-time pass, then daily.
  void runSourceDocumentSweeps();
  orphanSweepTimer = setInterval(() => {
    void runSourceDocumentSweeps();
  }, ORPHAN_SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive on its own (watchdog idiom).
  orphanSweepTimer.unref();
  jobLog.info(
    `cleanup:orphan-sources:start interval=24h staleAfter=30d ` +
      `urlSnapshotRetention=${URL_SNAPSHOT_RETENTION_DAYS}d press=${URL_SNAPSHOT_PRESS_RETENTION_DAYS}d`,
  );
};

export const stopSourceDocumentOrphanSweep = (): void => {
  if (!orphanSweepTimer) return;
  clearInterval(orphanSweepTimer);
  orphanSweepTimer = null;
};

export interface EditImpactResult {
  hasContent: boolean;
  hasProgress: boolean;
  completedLessons: number;
  inProgressLessons: number;
  totalNotes: number;
  totalBookmarks: number;
  quizAttempts: number;
  modulesWithMastery: number;
  scheduledReviews: number;
  totalTimeSpentMinutes: number;
}

/**
 * Assesses the impact of editing a course — how much content and progress exists
 * that would be lost if the course structure changes.
 */
export const getEditImpact = async ({ courseId, userId }: { courseId: string; userId: string }): Promise<EditImpactResult> => {
  const [contentCount, quizContentCount, lessonProgressAgg, quizProgressAgg] = await Promise.all([
    LessonContentModel.countDocuments({ courseId }),
    ModuleQuizContentModel.countDocuments({ courseId }),
    UserLessonProgressModel.aggregate([
      { $match: { courseId, userId } },
      {
        $group: {
          _id: null,
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
          totalNotes: { $sum: { $cond: [{ $and: [{ $ne: ['$notes', null] }, { $ne: ['$notes', ''] }] }, 1, 0] } },
          totalBookmarks: { $sum: { $cond: ['$bookmarked', 1, 0] } },
          totalTimeSpent: { $sum: '$timeSpentSeconds' },
        },
      },
    ]),
    UserModuleQuizProgressModel.aggregate([
      { $match: { courseId, userId } },
      {
        $group: {
          _id: null,
          totalAttempts: { $sum: { $size: '$attempts' } },
          modulesWithMastery: {
            $sum: { $cond: [{ $in: ['$bestTier', ['passed', 'mastered']] }, 1, 0] },
          },
          scheduledReviews: {
            $sum: { $cond: [{ $ne: ['$nextReviewAt', null] }, 1, 0] },
          },
        },
      },
    ]),
  ]);

  const lp = lessonProgressAgg[0] ?? {};
  const qp = quizProgressAgg[0] ?? {};

  return {
    hasContent: contentCount > 0 || quizContentCount > 0,
    hasProgress: (lp.completed ?? 0) > 0 || (lp.inProgress ?? 0) > 0 || (qp.totalAttempts ?? 0) > 0,
    completedLessons: lp.completed ?? 0,
    inProgressLessons: lp.inProgress ?? 0,
    totalNotes: lp.totalNotes ?? 0,
    totalBookmarks: lp.totalBookmarks ?? 0,
    quizAttempts: qp.totalAttempts ?? 0,
    modulesWithMastery: qp.modulesWithMastery ?? 0,
    scheduledReviews: qp.scheduledReviews ?? 0,
    totalTimeSpentMinutes: Math.round((lp.totalTimeSpent ?? 0) / 60),
  };
};
