import { Types } from 'mongoose';
import SourceDocumentChunkModel from '@models/SourceDocumentChunkModel';
import { SourceChunkType } from '@lib/constants';
import { embedBatch, embedQuery, isEmbeddingsEnabled } from '@lib/openaiEmbeddings';
import {
  deleteVectorsByIds,
  isPineconeEnabled,
  queryVectors,
  upsertVectors,
  type GenericVectorRecord,
} from '@lib/pinecone';
import { bgError } from '@lib/bg';
import { ragLog } from '@lib/loggers';
import type { ExtractionBlock } from './documentExtraction';

/**
 * User-document RAG corpus (Phase 4 of course-from-documents). Mirrors
 * `productKbRagService` for the third corpus on the shared Pinecone
 * index: chunks of the learner's uploaded source documents.
 *
 * Isolation model: Pinecone metadata `{ namespace: 'user-doc', userId,
 * courseId, documentId, chunkIndex }`; every read filters on
 * `{ namespace: 'user-doc', courseId }` AND re-verifies the metadata on
 * each hit post-query (the lesson-RAG isolation pattern — strays are
 * dropped and error-logged, never returned). Documents are personal data,
 * so unlike LessonChunk the Mongo rows carry `userId` for the
 * account-deletion backstop.
 *
 * Deletion model: serverless Pinecone deletes by explicit id only, so the
 * Mongo chunk rows double as the vector-deletion manifest. Every delete
 * here reads vectorIds from Mongo FIRST, deletes the Pinecone vectors,
 * and removes the Mongo rows only when the vector delete succeeded —
 * losing the manifest before the vectors would orphan them permanently
 * (a right-to-erasure hole, not just clutter).
 *
 * Write model: wipe-then-write per document (idempotent re-ingest), and
 * Pinecone upsert BEFORE the Mongo insert — on upsert failure we abort
 * with no Mongo rows, so the store never claims chunks that have no
 * vectors (the lessonRag ordering, `lessonRagService.ts:208-220`).
 */

const NAMESPACE = 'user-doc';

// Same knobs as the other two corpora (lessonRagService / productKbRagService).
export const SOURCE_CHUNK_TARGET_CHARS = 1500;
export const SOURCE_CHUNK_OVERLAP_CHARS = 150;

/**
 * Slice size for embedding requests. `embedBatch` sends ALL inputs in one
 * OpenAI request (fine for the 5–20-chunk lesson/KB corpora, per its own
 * comment) — a 300-page document can produce 1000+ chunks, so this call
 * site slices. 300 inputs × ~1.5 KB ≈ 110k tokens/request, comfortably
 * inside the embeddings endpoint's 2048-input / 300k-token limits.
 */
export const EMBED_BATCH_MAX_INPUTS = 300;

/** Mongo chunk `text` is capped at 50k (schema); slice defensively below it. */
const CHUNK_TEXT_HARD_CAP = 48_000;

// ── Chunker ─────────────────────────────────────────────

export interface SourceChunkInput {
  chunkType: SourceChunkType;
  text: string;
  headingPath: string[];
  pageRange: { start: number; end: number } | null;
}

const sameHeading = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const mergeRange = (
  a: { start: number; end: number } | null,
  b: { start: number; end: number } | null,
): { start: number; end: number } | null => {
  if (!a) return b;
  if (!b) return a;
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
};

/**
 * Heading-aware chunker over the extraction contract's blocks:
 *   - `table` / `figure` blocks are ATOMIC — emitted whole, never split
 *     or merged (Topo-RAG finding recorded in the plan §3.3).
 *   - consecutive `text` blocks under the SAME headingPath merge into a
 *     section buffer, then split on paragraph boundaries at
 *     ~SOURCE_CHUNK_TARGET_CHARS with SOURCE_CHUNK_OVERLAP_CHARS of
 *     bridge carry-over (the productKb splitter's shape).
 *   - a headingPath change always starts a new chunk (retrieval cites
 *     the heading trail; mixing sections poisons that).
 */
export const chunkExtractionBlocks = (blocks: ExtractionBlock[]): SourceChunkInput[] => {
  const chunks: SourceChunkInput[] = [];

  let buffer = '';
  let bufferHeading: string[] = [];
  let bufferRange: { start: number; end: number } | null = null;

  const flush = () => {
    const text = buffer.trim();
    if (text) {
      chunks.push({
        chunkType: 'text',
        text: text.slice(0, CHUNK_TEXT_HARD_CAP),
        headingPath: bufferHeading,
        pageRange: bufferRange,
      });
    }
    buffer = '';
    bufferRange = null;
  };

  for (const block of blocks) {
    const blockRange = block.pageRange ?? null;

    if (block.type === 'table' || block.type === 'figure') {
      flush();
      const text = block.markdown.trim();
      if (text) {
        chunks.push({
          chunkType: block.type,
          text: text.slice(0, CHUNK_TEXT_HARD_CAP),
          headingPath: block.headingPath,
          pageRange: blockRange,
        });
      }
      continue;
    }

    if (buffer && !sameHeading(bufferHeading, block.headingPath)) flush();
    bufferHeading = block.headingPath;

    const paragraphs = block.markdown
      .split(/\n\n+/)
      .flatMap((p) => (p.length > SOURCE_CHUNK_TARGET_CHARS * 2 ? p.split(/\n+/) : [p]))
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    for (const para of paragraphs) {
      if (buffer.length > 0 && buffer.length + para.length + 2 > SOURCE_CHUNK_TARGET_CHARS) {
        const overlap = buffer.slice(-SOURCE_CHUNK_OVERLAP_CHARS);
        flush();
        // Bridge context from the prior chunk (same-section continuity).
        buffer = overlap + '\n\n' + para;
        bufferRange = blockRange;
      } else {
        buffer = buffer ? buffer + '\n\n' + para : para;
        bufferRange = mergeRange(bufferRange, blockRange);
      }
    }
  }
  flush();

  return chunks;
};

// ── Vector ids ──────────────────────────────────────────

/** Contract format (plan §3.3): `doc:{courseId}:{documentId}:{chunkIndex}`. */
export const buildSourceVectorId = ({
  courseId,
  documentId,
  chunkIndex,
}: {
  courseId: string;
  documentId: string;
  chunkIndex: number;
}): string => `doc:${courseId}:${documentId}:${chunkIndex}`;

// ── Index (wipe-then-write per document) ────────────────

export interface IndexSourceDocumentResult {
  ok: boolean;
  chunksWritten: number;
  reason?: 'disabled' | 'empty' | 'wipe_failed' | 'embed_failed' | 'pinecone_failed' | 'mongo_failed';
}

export const indexSourceDocument = async ({
  userId,
  courseId,
  documentId,
  blocks,
}: {
  userId: string;
  courseId: string;
  documentId: string;
  blocks: ExtractionBlock[];
}): Promise<IndexSourceDocumentResult> => {
  const tag = `${NAMESPACE}/${courseId}/${documentId}`;

  if (!isEmbeddingsEnabled() || !isPineconeEnabled()) {
    ragLog.info(`srcdoc:index:skip doc=${tag} reason=disabled`);
    return { ok: false, chunksWritten: 0, reason: 'disabled' };
  }

  const chunkInputs = chunkExtractionBlocks(blocks);
  if (chunkInputs.length === 0) {
    ragLog.info(`srcdoc:index:skip doc=${tag} reason=empty`);
    return { ok: false, chunksWritten: 0, reason: 'empty' };
  }

  const t0 = Date.now();
  ragLog.info(`srcdoc:index:start doc=${tag} chunks=${chunkInputs.length}`);

  // Wipe prior chunks for THIS document (idempotent re-ingest). Vectors
  // first, manifest second: if the Pinecone delete fails we keep the Mongo
  // rows (they are the only way to ever find those vectors again) and
  // abort — the re-upsert below reuses the same vectorId space anyway, so
  // a retry converges.
  const prior = await SourceDocumentChunkModel.find({
    courseId: new Types.ObjectId(courseId),
    documentId: new Types.ObjectId(documentId),
  })
    .select('vectorId')
    .lean();

  if (prior.length > 0) {
    const wiped = await deleteVectorsByIds(prior.map((c) => c.vectorId), { action: 'delete:user-doc' });
    if (!wiped) {
      ragLog.warn(`srcdoc:index:abort doc=${tag} reason=wipe_failed`);
      return { ok: false, chunksWritten: 0, reason: 'wipe_failed' };
    }
    await SourceDocumentChunkModel.deleteMany({
      courseId: new Types.ObjectId(courseId),
      documentId: new Types.ObjectId(documentId),
    });
  }

  // Embed in slices (see EMBED_BATCH_MAX_INPUTS) — one failed slice fails
  // the document (retryable), never a partially-embedded corpus.
  const embeddings: number[][] = [];
  for (let i = 0; i < chunkInputs.length; i += EMBED_BATCH_MAX_INPUTS) {
    const slice = chunkInputs.slice(i, i + EMBED_BATCH_MAX_INPUTS);
    const sliceEmbeddings = await embedBatch(
      slice.map((c) => c.text),
      { action: 'embedding:index' },
    );
    if (!sliceEmbeddings) {
      ragLog.warn(`srcdoc:index:embed-fail doc=${tag} slice=${i / EMBED_BATCH_MAX_INPUTS}`);
      return { ok: false, chunksWritten: 0, reason: 'embed_failed' };
    }
    embeddings.push(...sliceEmbeddings);
  }

  const records: GenericVectorRecord[] = [];
  const chunkDocs = chunkInputs.map((input, chunkIndex) => {
    const vectorId = buildSourceVectorId({ courseId, documentId, chunkIndex });
    records.push({
      id: vectorId,
      embedding: embeddings[chunkIndex],
      metadata: {
        namespace: NAMESPACE,
        userId,
        courseId,
        documentId,
        chunkIndex,
      },
    });
    return {
      userId: new Types.ObjectId(userId),
      courseId: new Types.ObjectId(courseId),
      documentId: new Types.ObjectId(documentId),
      chunkIndex,
      chunkType: input.chunkType,
      text: input.text,
      headingPath: input.headingPath,
      pageRange: input.pageRange,
      vectorId,
    };
  });

  // Pinecone BEFORE Mongo — abort on failure so we never persist a
  // manifest row whose vector doesn't exist.
  const upserted = await upsertVectors(records, { action: 'upsert:user-doc' });
  if (!upserted) {
    ragLog.warn(`srcdoc:index:abort doc=${tag} reason=pinecone_upsert_failed`);
    return { ok: false, chunksWritten: 0, reason: 'pinecone_failed' };
  }

  const inserted = await SourceDocumentChunkModel.insertMany(chunkDocs).catch((e) => {
    bgError('sourceDocRag.insertMongoChunks')(e);
    return null;
  });
  if (!inserted) {
    // Vectors exist but the manifest write failed — compensate by deleting
    // the vectors we just wrote (we still hold their ids), so nothing is
    // ever unreachable-by-manifest.
    await deleteVectorsByIds(records.map((r) => r.id), { action: 'delete:user-doc' }).catch(
      bgError('sourceDocRag.compensateVectorDelete') as (e: unknown) => boolean,
    );
    return { ok: false, chunksWritten: 0, reason: 'mongo_failed' };
  }

  ragLog.info(`srcdoc:index:done doc=${tag} chunks=${chunkInputs.length} ms=${Date.now() - t0}`);
  return { ok: true, chunksWritten: chunkInputs.length };
};

// ── Search ──────────────────────────────────────────────

export interface SourceDocSearchResult {
  documentId: string;
  chunkIndex: number;
  chunkType: SourceChunkType;
  headingPath: string[];
  pageRange: { start: number; end: number } | null;
  text: string;
  score: number;
}

/**
 * Vector-search the course's document corpus. Filter is always
 * `{ namespace: 'user-doc', courseId }` (+ `documentId` when given);
 * every hit's metadata is re-verified post-query and strays are dropped
 * with an error log (the copied isolation pattern). Text is hydrated from
 * `SourceDocumentChunkModel` by vectorId with the rank-preserving Map join.
 */
export const searchSourceDocuments = async (
  courseId: string,
  query: string,
  { topK = 5, documentId }: { topK?: number; documentId?: string } = {},
): Promise<SourceDocSearchResult[]> => {
  const scope = `${courseId}${documentId ? `/${documentId}` : ''}`;

  if (!isEmbeddingsEnabled() || !isPineconeEnabled()) {
    ragLog.info(`srcdoc:query:skip scope=${scope} reason=disabled`);
    return [];
  }

  const trimmed = query.trim();
  if (!trimmed) {
    ragLog.info(`srcdoc:query:skip scope=${scope} reason=empty_query`);
    return [];
  }

  const t0 = Date.now();
  const queryEmbedding = await embedQuery(trimmed);
  if (!queryEmbedding) {
    ragLog.warn(`srcdoc:query:embed-fail scope=${scope}`);
    return [];
  }

  const filter: Record<string, string> = { namespace: NAMESPACE, courseId };
  if (documentId) filter.documentId = documentId;

  const hits = await queryVectors({
    embedding: queryEmbedding,
    filter,
    topK,
    action: 'query:user-doc',
  });
  if (hits.length === 0) {
    ragLog.info(`srcdoc:query:miss scope=${scope} ms=${Date.now() - t0}`);
    return [];
  }

  // Defense-in-depth: re-verify the discriminators on every hit. A drift
  // between Pinecone filter behavior and this expectation would be a
  // cross-tenant isolation bug — make it loud, return nothing foreign.
  const isSafe = (h: (typeof hits)[number]) =>
    h.metadata.namespace === NAMESPACE &&
    h.metadata.courseId === courseId &&
    (!documentId || h.metadata.documentId === documentId);
  const stray = hits.filter((h) => !isSafe(h));
  if (stray.length > 0) {
    ragLog.error(
      `srcdoc:query:isolation-violation scope=${scope} foreign=${stray.length} ids=${stray.map((s) => s.id).join(',')}`,
    );
  }
  const safeHits = hits.filter(isSafe);

  const chunks = await SourceDocumentChunkModel.find({ vectorId: { $in: safeHits.map((h) => h.id) } })
    .select('vectorId documentId chunkIndex chunkType headingPath pageRange text')
    .lean();

  // Preserve Pinecone's rank via the vectorId Map join.
  const byVectorId = new Map(chunks.map((c) => [c.vectorId, c]));
  const results = safeHits
    .map((h) => {
      const c = byVectorId.get(h.id);
      if (!c) return null;
      return {
        documentId: c.documentId.toString(),
        chunkIndex: c.chunkIndex,
        chunkType: c.chunkType,
        headingPath: c.headingPath,
        pageRange: c.pageRange,
        text: c.text,
        score: h.score,
      };
    })
    .filter((r): r is SourceDocSearchResult => r !== null);

  ragLog.info(
    `srcdoc:query:hits scope=${scope} hits=${results.length}/${hits.length} ms=${Date.now() - t0}`,
  );
  return results;
};

// ── Deletion (Mongo manifest first) ─────────────────────

interface SourceChunkDeleteResult {
  chunksDeleted: number;
  vectorsDeleted: number;
}

/**
 * Shared delete core: read the vectorId manifest from Mongo, delete the
 * Pinecone vectors, and delete the Mongo rows ONLY when the vector delete
 * succeeded — a failed vector delete keeps the manifest so a retry can
 * still enumerate the ids (losing it orphans the vectors permanently).
 */
const deleteChunksByQuery = async (
  query: Record<string, unknown>,
  label: string,
): Promise<SourceChunkDeleteResult> => {
  const chunks = await SourceDocumentChunkModel.find(query).select('vectorId').lean();
  if (chunks.length === 0) return { chunksDeleted: 0, vectorsDeleted: 0 };

  const vectorIds = chunks.map((c) => c.vectorId);
  const vectorsOk = await deleteVectorsByIds(vectorIds, { action: 'delete:user-doc' });
  if (!vectorsOk) {
    ragLog.error(`srcdoc:cleanup:vector-delete-failed ${label} ids=${vectorIds.length} — manifest retained for retry`);
    return { chunksDeleted: 0, vectorsDeleted: 0 };
  }

  const mongoResult = await SourceDocumentChunkModel.deleteMany(query);
  ragLog.info(`srcdoc:cleanup ${label} chunks=${mongoResult.deletedCount} vectors=${vectorIds.length}`);
  return { chunksDeleted: mongoResult.deletedCount, vectorsDeleted: vectorIds.length };
};

/** Course-deletion cascade entry (via `cleanupCourseSources`). */
export const deleteSourceChunksForCourse = async (courseId: string): Promise<SourceChunkDeleteResult> =>
  deleteChunksByQuery({ courseId: new Types.ObjectId(courseId) }, `course=${courseId}`);

/** Single-document deletion (document delete endpoint / re-ingest tooling). */
export const deleteSourceChunksForDocument = async (documentId: string): Promise<SourceChunkDeleteResult> =>
  deleteChunksByQuery({ documentId: new Types.ObjectId(documentId) }, `doc=${documentId}`);

/**
 * Retention-sweep deletion: drop every chunk of a document EXCEPT the
 * vectorIds the course structure cites as grounding a lesson
 * (`structure.modules[].lessons[].sourceRefs`).
 *
 * This is the code half of the published sentence "after that we keep only
 * … the specific excerpts your lessons draw on" (ToS §6.2 / Privacy §5) —
 * the bulk copy of the page goes, the cited excerpts stay, and
 * `contextLoad` can still hydrate the refs of a lesson generated later.
 *
 * Passing an empty keep-set is exactly `deleteSourceChunksForDocument`.
 * Runs through the same manifest-first core, so a failed Pinecone delete
 * still leaves the Mongo rows behind as the retry manifest.
 */
export const deleteSourceChunksForDocumentExcept = async (
  documentId: string,
  keepVectorIds: readonly string[],
): Promise<SourceChunkDeleteResult> =>
  deleteChunksByQuery(
    {
      documentId: new Types.ObjectId(documentId),
      ...(keepVectorIds.length > 0 ? { vectorId: { $nin: [...keepVectorIds] } } : {}),
    },
    `doc=${documentId} retained=${keepVectorIds.length}`,
  );

/** Account-deletion FK-drift backstop — catches rows whose course is gone. */
export const deleteSourceChunksForUser = async (userId: string): Promise<SourceChunkDeleteResult> =>
  deleteChunksByQuery({ userId: new Types.ObjectId(userId) }, `user=${userId}`);
