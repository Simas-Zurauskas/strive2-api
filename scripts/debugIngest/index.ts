// The import graph below reaches middleware that reads `req.userId` — pull
// the global Express augmentation in explicitly, since ts-node compiles
// this script outside the tsconfig `include` set that normally carries it.
/// <reference path="../../src/types/express.d.ts" />
import 'colors';
import dotenv from 'dotenv';
import path from 'path';

// Load the API's .env BEFORE importing anything that touches `@conf/env`.
// Same pattern as debugOrchestrator: env is read at module-import time.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import crypto from 'crypto';
import { hash } from 'bcryptjs';
import mongoose from 'mongoose';
import { MONGO_URI } from '@conf/env';
import { DOCUMENTS_PLACEHOLDER_GOAL } from '@lib/constants';
import { fetchVectorIds } from '@lib/pinecone';
import { runWithUsageContext } from '@lib/usageContext';
import UserModel from '@models/UserModel';
import CourseModel from '@models/CourseModel';
import JobModel from '@models/JobModel';
import SourceDocumentModel from '@models/SourceDocumentModel';
import SourceDocumentChunkModel from '@models/SourceDocumentChunkModel';
import { AuthProvider } from '@lib/constants';
import { executeJob } from '@services/jobRunner';
import { jobEvents } from '@services/jobEvents';
import { createFileDocument } from '@services/sourceDocumentService';
import { cleanupCourseContent, cleanupCourseSources } from '@services/courseCleanupService';
import { listKeysByPrefix } from '@services/s3Service';
import { buildPdf, buildDocx } from '@src/services/documentExtraction/__fixtures__/builders';

/**
 * yarn debug:ingest — drives the Phase-4 ingest execution path end-to-end
 * against the REAL dev Mongo / S3 / Pinecone / OpenAI / Anthropic from
 * api/.env (embedding + Haiku calls cost cents), modeled on
 * debug:orchestrator but calling `executeJob` directly instead of HTTP.
 *
 * Flow: throwaway user + `source:'documents'` course → 2 fixture docs
 * (text-PDF + DOCX from the documentExtraction fixture builders, uploaded
 * through the real Phase-1 service so S3/dedup/caps run for real) →
 * `executeJob({type:'ingest_documents'})` inside a usage scope → prints
 * per-doc statuses, chunk rows, Pinecone vector count (fetch-by-id),
 * digest topic count, assessment summary → full-cleanup deletion → prints
 * the ZERO-ORPHAN PROOF (Mongo counts 0, Pinecone fetch empty, S3 prefix
 * listing empty — `quarantine/` sits outside `uploads/` by construction
 * and is never listed or touched).
 *
 * Idempotent + self-cleaning: everything is created fresh per run and
 * torn down in `finally`, even when the ingest itself fails.
 */

const PDF_PAGES = [
  'Spaced repetition is a learning technique that schedules reviews of material at increasing intervals. ' +
    'Each successful recall pushes the next review further into the future, exploiting the psychological spacing effect. ' +
    'The Leitner system implements this with numbered boxes: a correct answer promotes a card to the next box, a miss demotes it to box one.',
  'Retrieval practice — actively recalling information rather than re-reading it — is among the most robust findings in learning science. ' +
    'Combining retrieval practice with spacing yields durable long-term retention, which is why flashcard scheduling algorithms matter.',
];

const banner = (text: string) => {
  console.log('');
  console.log(`── ${text} `.padEnd(60, '─').cyan);
};

async function main() {
  console.log('Debug Ingest — course-from-documents Phase 4 harness'.cyan);
  console.log('─'.repeat(56).dim);

  // Direct mongoose connection — NOT connectDB() (its boot reaper would
  // fail all in-flight jobs on a live dev server).
  console.log('\nConnecting to MongoDB...'.gray);
  await mongoose.connect(MONGO_URI);
  console.log('MongoDB connected.'.green);

  const runId = crypto.randomBytes(4).toString('hex');
  let userId: string | null = null;
  let courseId: string | null = null;
  let vectorIdsAtPeak: string[] = [];
  let ok = false;

  try {
    // ── Throwaway user + documents course ──
    banner('setup');
    const user = await UserModel.create({
      email: `debug-ingest-${runId}@strive-debug.test`,
      name: `Debug Ingest ${runId}`,
      password: await hash(`debug-${runId}`, 10),
      emailVerified: true,
      authProviders: [{ provider: AuthProvider.CREDENTIALS }],
    });
    userId = user._id.toString();
    const course = await CourseModel.create({
      userId: user._id,
      goal: DOCUMENTS_PLACEHOLDER_GOAL,
      status: 'creating',
      source: 'documents',
    });
    courseId = course._id.toString();
    console.log(`user=${userId} course=${courseId}`);

    // ── Inject 2 fixture docs through the real upload service ──
    const pdf = await createFileDocument({
      userId,
      courseId,
      buffer: buildPdf(PDF_PAGES),
      filename: 'spaced-repetition-notes.pdf',
    });
    const docx = await createFileDocument({
      userId,
      courseId,
      buffer: buildDocx({ withTable: true }),
      filename: 'fixture-handbook.docx',
    });
    console.log(`uploaded pdf=${pdf.document._id} docx=${docx.document._id}`);

    // ── Run the ingest execution path directly ──
    banner('ingest (executeJob, real providers — costs cents)');
    const onProgress = (payload: { type: string; event?: { type?: string; documentId?: string; status?: string } }) => {
      if (payload.event?.type === 'document_status') {
        console.log(`  event doc=${payload.event.documentId} status=${payload.event.status}`.gray);
      }
    };
    jobEvents.on('progress', onProgress);
    const jobId = new mongoose.Types.ObjectId().toString();
    const t0 = Date.now();
    try {
      await runWithUsageContext({
        ctx: { userId, source: 'job', jobId, courseId, creditBucketAtScope: 'allowance' },
        fn: () =>
          executeJob({
            jobId,
            userId: userId!,
            courseId: courseId!,
            type: 'ingest_documents',
            metadata: null,
          }),
      });
    } finally {
      jobEvents.off('progress', onProgress);
    }
    console.log(`ingest completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`.green);

    // ── Report ──
    banner('results');
    const docs = await SourceDocumentModel.find({ courseId }).lean();
    for (const d of docs) {
      console.log(
        `doc ${d.filename}: status=${d.status} pages=${d.pageCount} tokens=${d.extractedTokens} warnings=[${d.warnings.join('; ')}]`,
      );
    }
    const chunks = await SourceDocumentChunkModel.find({ courseId }).lean();
    vectorIdsAtPeak = chunks.map((c) => c.vectorId);
    const vectorsFound = await fetchVectorIds(vectorIdsAtPeak);
    const courseAfter = await CourseModel.findById(courseId).lean();
    const digest = courseAfter?.sourceDigest as { topics?: unknown[] } | null;
    const assessment = courseAfter?.sourceAssessment as
      | { topics?: string[]; sizeBand?: { minLessons: number; maxLessons: number; mode: string }; suggestedGoal?: string; warnings?: string[] }
      | null;

    console.log(`chunk rows        : ${chunks.length}`);
    console.log(`pinecone vectors  : ${vectorsFound.length}/${vectorIdsAtPeak.length} (fetch by id)`);
    console.log(`digest topics     : ${digest?.topics?.length ?? 0}`);
    console.log(`assessment topics : ${(assessment?.topics ?? []).join(', ')}`);
    console.log(
      `assessment band   : ${assessment?.sizeBand?.minLessons}-${assessment?.sizeBand?.maxLessons} lessons (${assessment?.sizeBand?.mode})`,
    );
    console.log(`suggested goal    : ${assessment?.suggestedGoal}`);
    if (assessment?.warnings?.length) console.log(`warnings          : ${assessment.warnings.join(' | ')}`);

    const allParsed = docs.length === 2 && docs.every((d) => d.status === 'parsed');
    const corpusLive = chunks.length > 0 && vectorsFound.length === vectorIdsAtPeak.length && (digest?.topics?.length ?? 0) > 0;
    ok = allParsed && corpusLive && Boolean(assessment?.suggestedGoal);
    console.log(ok ? '\ningest checks PASSED'.green : '\ningest checks FAILED'.red);
  } catch (err) {
    console.error('\nFATAL during ingest run:'.red, err);
    ok = false;
  } finally {
    // ── Full cleanup + zero-orphan proof (runs even on failure) ──
    if (courseId && userId) {
      banner('cleanup + zero-orphan proof');
      try {
        await cleanupCourseContent(courseId);
        await cleanupCourseSources({ courseId, userId });
        await JobModel.deleteMany({ courseId });
        await CourseModel.deleteOne({ _id: courseId });
        await UserModel.deleteOne({ _id: userId });

        const docCount = await SourceDocumentModel.countDocuments({ courseId });
        const chunkCount = await SourceDocumentChunkModel.countDocuments({ courseId });
        // Pinecone serverless is eventually consistent — a successful delete
        // can take seconds to become visible to fetch. Poll with a bounded
        // window before declaring orphans.
        let vectorsLeft: string[] = [];
        if (vectorIdsAtPeak.length > 0) {
          const deadline = Date.now() + 60_000;
          for (;;) {
            vectorsLeft = await fetchVectorIds(vectorIdsAtPeak);
            if (vectorsLeft.length === 0 || Date.now() > deadline) break;
            console.log(`  waiting for pinecone delete visibility (${vectorsLeft.length} still fetchable)...`.gray);
            await new Promise((r) => setTimeout(r, 5_000));
          }
        }
        // The whole course prefix, incl. parsed/ artifacts. quarantine/ is
        // outside uploads/ by design and thus excluded by construction.
        const s3Keys = await listKeysByPrefix(`uploads/${userId}/${courseId}/`);

        console.log(`SourceDocument rows : ${docCount}`);
        console.log(`chunk rows          : ${chunkCount}`);
        console.log(`pinecone vectors    : ${vectorsLeft.length}`);
        console.log(`s3 keys under prefix: ${s3Keys.length}`);
        const zeroOrphans = docCount === 0 && chunkCount === 0 && vectorsLeft.length === 0 && s3Keys.length === 0;
        console.log(zeroOrphans ? 'ZERO-ORPHAN PROOF PASSED'.green : 'ORPHANS REMAIN — investigate'.red);
        if (!zeroOrphans) ok = false;
      } catch (cleanupErr) {
        console.error('cleanup failed — manual sweep needed:'.red, cleanupErr);
        ok = false;
      }
    }
    await mongoose.disconnect();
    console.log('MongoDB disconnected.'.gray);
  }

  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
